import {PHP_INIT} from './php-init.ts';
import {exists} from "https://deno.land/std/fs/mod.ts";
import {sleep} from "https://deno.land/x/sleep/mod.ts";

const PHP_CLI_NAME = 'php';
const SOCKET_NAME = '/tmp/deno-php-commands-io';
const ASSERTIONS_ENABLED = true;
const DEBUG_PHP_INIT = false;

const REC_CONST = 0;
const REC_GET = 1;
const REC_SET = 2;
const REC_SET_PATH = 3;
const REC_CLASSSTATIC_GET = 4;
const REC_CLASSSTATIC_SET = 5;
const REC_CLASSSTATIC_SET_PATH = 6;
const REC_CONSTRUCT = 7;
const REC_DESTRUCT = 8;
const REC_CLASS_GET = 9;
const REC_CLASS_SET = 10;
const REC_CLASS_CALL = 11;
const REC_CALL = 12;
const REC_CALL_EVAL = 13;
const REC_CALL_ECHO = 14;
const REC_CALL_INCLUDE = 15;
const REC_CALL_INCLUDE_ONCE = 16;
const REC_CALL_REQUIRE = 17;
const REC_CALL_REQUIRE_ONCE = 18;

const RE_BAD_CLASSNAME_FOR_EVAL = /[^\w\\]/;

function assert(expr: unknown): asserts expr
{	if (ASSERTIONS_ENABLED && !expr)
	{	throw new Error('Assertion failed');
	}
}

export class InterpreterError extends Error
{	constructor(public message: string, public file: string, public line: number, public trace: string)
	{	super(message);
	}
}

export class PhpInterpreter
{	public g: any;
	public c: any;

	private proc: Deno.Process|undefined;
	private socket: Deno.Listener|undefined;
	private commands_io: Deno.Conn|undefined;
	private is_initing = false;
	private ongoing: Promise<unknown> = Promise.resolve();
	private encoder = new TextEncoder;
	private decoder = new TextDecoder;

	constructor()
	{	this.g = get_global(this, false);
		this.c = get_global(this, true);

		function get_global(php: PhpInterpreter, is_class: boolean)
		{	return new Proxy
			(	php,
				{	get(php, prop_name)
					{	if (typeof(prop_name)!='string' || prop_name.length==0)
						{	throw new Error('Invalid object name');
						}
						return get_proxy
						(	[prop_name],

							// get
							async path =>
							{	let path_str;
								let record_type;
								if (!is_class)
								{	// case: A\B\C
									// or case: $var
									// or case: $var['a']['b']
									if (path[0].charAt(0) != '$')
									{	// case: A\B\C
										path_str = path.join('\\');
										record_type = REC_CONST;
									}
									else
									{	path_str = path[0].slice(1); // cut '$'
										if (path_str.indexOf(' ') != -1)
										{	throw new Error(`Variable name must not contain spaces: $${path_str}`);
										}
										if (path.length > 1)
										{	path_str += ' '+JSON.stringify(path.slice(1));
										}
										record_type = REC_GET;
									}
								}
								else
								{	// case: A\B::C
									// or case: A\B::$c
									// or case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i == -1)
									{	// case: A\B::C
										path_str = path.slice(0, -1).join('\\')+'::'+path[path.length-1];
										record_type = REC_CONST;
									}
									else if (var_i == 0)
									{	throw new Error(`Invalid object usage: ${path.join('.')}`);
									}
									else
									{	path_str = path.slice(0, var_i).join('\\');
										if (path_str.indexOf(' ') != -1)
										{	throw new Error(`Class/namespace names must not contain spaces: ${path_str}`);
										}
										if (path[var_i].indexOf(' ') != -1)
										{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
										}
										path_str += ' '+path[var_i].slice(1); // cut '$'
										if (var_i+1 < path.length)
										{	path_str += ' '+JSON.stringify(path.slice(var_i+1));
										}
										record_type = REC_CLASSSTATIC_GET;
									}
								}
								await php.write(record_type, path_str);
								return await php.read();
							},

							// set
							(path, value) =>
							{	assert(path.length > 1);
								let path_str;
								let record_type;
								if (!is_class)
								{	// case: $var['a']['b']
									if (path[0].charAt(0) != '$')
									{	throw new Error(`Cannot set this object: ${path.join('.')}`);
									}
									path_str = path[0].slice(1); // cut '$'
									if (path_str.indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: $${path_str}`);
									}
									path_str += ' '+JSON.stringify([path.slice(1), value]);
									record_type = REC_SET_PATH;
								}
								else
								{	// case: A\B::$c
									// or case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i <= 0)
									{	throw new Error(`Cannot set this object: ${path.join('.')}`);
									}
									path_str = path.slice(0, var_i).join('\\');
									if (RE_BAD_CLASSNAME_FOR_EVAL.test(path_str))
									{	throw new Error(`Cannot use such class name: ${path_str}`);
									}
									if (path[var_i].indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
									}
									path_str += ' '+path[var_i].slice(1); // cut '$'
									if (var_i+1 >= path.length)
									{	if (value != null)
										{	path_str += ' '+JSON.stringify(value);
										}
										record_type = REC_CLASSSTATIC_SET;
									}
									else
									{	path_str += ' '+JSON.stringify([path.slice(var_i+1), value]);
										record_type = REC_CLASSSTATIC_SET_PATH;
									}
								}
								php.write(record_type, path_str);
								return true;
							},

							// apply
							async (path, args) =>
							{	// case: function
								let path_str;
								let record_type = REC_CALL;
								if (!is_class)
								{	if (path.length == 1)
									{	// case: func_name()
										path_str = path[0];
										switch (path_str.toLowerCase())
										{	case 'exit':
												return await php.exit();
											case 'eval':
												if (args.length != 1)
												{	throw new Error('Invalid number of arguments to eval()');
												}
												path_str = JSON.stringify(args[0]);
												record_type = REC_CALL_EVAL;
												break;
											case 'echo':
												path_str = JSON.stringify([...args]);
												record_type = REC_CALL_ECHO;
												break;
											case 'include':
												if (args.length != 1)
												{	throw new Error('Invalid number of arguments to include()');
												}
												path_str = JSON.stringify(args[0]);
												record_type = REC_CALL_INCLUDE;
												break;
											case 'include_once':
												if (args.length != 1)
												{	throw new Error('Invalid number of arguments to include_once()');
												}
												path_str = JSON.stringify(args[0]);
												record_type = REC_CALL_INCLUDE_ONCE;
												break;
											case 'require':
												if (args.length != 1)
												{	throw new Error('Invalid number of arguments to require()');
												}
												path_str = JSON.stringify(args[0]);
												record_type = REC_CALL_REQUIRE;
												break;
											case 'require_once':
												if (args.length != 1)
												{	throw new Error('Invalid number of arguments to require_once()');
												}
												path_str = JSON.stringify(args[0]);
												record_type = REC_CALL_REQUIRE_ONCE;
												break;
											default:
												if (args.length != 0)
												{	path_str += ' '+JSON.stringify([...args]);
												}
										}
									}
									else
									{	// case: A\B\c()
										path_str = path.join('\\');
										if (args.length != 0)
										{	path_str += ' '+JSON.stringify([...args]);
										}
									}
								}
								else if (path.length > 1)
								{	// case: A\B::c()
									path_str = path.slice(0, -1).join('\\')+'::'+path[path.length-1];
									if (args.length != 0)
									{	path_str += ' '+JSON.stringify([...args]);
									}
								}
								else
								{	// case: ClassName
									throw new Error(`Invalid class name usage: ${path[0]}`);
								}
								await php.write(record_type, path_str);
								return await php.read();
							},

							// construct
							async (path, args) =>
							{	let class_name = path.join('\\');
								await php.write(REC_CONSTRUCT, args.length==0 ? class_name : class_name+' '+JSON.stringify([...args]));
								let h_inst = (await php.read())|0;
								return new Proxy
								(	php,
									{	has(php, prop_name)
										{	return prop_name != 'then'; // so "await new Class" will finish awaiting
										},
										get(php, prop_name) // set class variable or function to call
										{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>128 || prop_name.indexOf(' ')!=-1)
											{	throw new Error('Invalid property name');
											}
											if (prop_name == 'then')
											{	return; // undefined
											}
											let promise: Promise<any>|undefined;
											return new Proxy
											(	() => {},
												{	get(_, prop_name_2)
													{	if (!promise)
														{	promise = php.write(REC_CLASS_GET, h_inst+' '+prop_name).then(() => php.read());
														}
														if (prop_name_2 == 'then')
														{	return (y: any, n: any) => promise!.then(y, n);
														}
														else if (prop_name_2 == 'catch')
														{	return (n: any) => promise!.catch(n);
														}
														else if (prop_name_2 == 'finally')
														{	return (y: any) => promise!.finally(y);
														}
														else
														{	throw new Error(`Instance property "${prop_name}": value must be awaited`);
														}
													},
													set(_, prop_name_2, val)
													{	return false
													},
													async apply(_, proxy, args)
													{	await php.write(REC_CLASS_CALL, args.length==0 ? h_inst+' '+prop_name : h_inst+' '+prop_name+' '+JSON.stringify([...args]));
														return await php.read();
													}
												}
											)
										},
										set(php, prop_name, value) // set class variable
										{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>128 || prop_name.indexOf(' ')!=-1)
											{	throw new Error('Invalid property name');
											}
											php.write(REC_CLASS_SET, value==null ? h_inst+' '+prop_name : h_inst+' '+prop_name+' '+JSON.stringify(value));
											return true;
										},
										deleteProperty(_, prop_name)
										{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>128 || prop_name.indexOf(' ')!=-1)
											{	return false;
											}
											if (prop_name == 'this')
											{	php.write(REC_DESTRUCT, h_inst+'');
												return true;
											}
											return false;
										}
									}
								);
							}
						);
					},
					set(php, prop_name, value)
					{	if (typeof(prop_name) != 'string')
						{	throw new Error('Cannot use such object like this');
						}
						if (is_class)
						{	throw new Error(`Invalid class name: ${prop_name}`);
						}
						if (prop_name.charAt(0) != '$')
						{	throw new Error(`Invalid global variable name: ${prop_name}`);
						}
						prop_name = prop_name.slice(1); // cut '$'
						php.write(REC_SET, value==null ? prop_name : prop_name+' '+JSON.stringify(value));
						return true;
					}
				}
			);
		}
	}

	private async init()
	{	this.socket = Deno.listen({path: SOCKET_NAME, transport: 'unix'});
		await sleep(0);
		let cmd = DEBUG_PHP_INIT ? [PHP_CLI_NAME, 'php-init.ts'] : [PHP_CLI_NAME, '-r', PHP_INIT.slice('<?php\n\n'.length)];
		if (Deno.args.length)
		{	cmd.splice(cmd.length, 0, '--', ...Deno.args);
		}
		this.proc = Deno.run({cmd, stdin: 'piped', stdout: 'inherit', stderr: 'inherit'});
		this.commands_io = await this.socket.accept();
		this.is_initing = false;
	}

	private write(record_type: number, str: string)
	{	str = '01230123'+str;
		let body = this.encoder.encode(str);
		let len = new DataView(body.buffer);
		len.setInt32(0, record_type);
		len.setInt32(4, body.length - 8);
		if (!this.commands_io && !this.is_initing)
		{	this.is_initing = true;
			let ongoing = this.ongoing;
			this.ongoing = this.init().then(() => ongoing);
		}
		this.ongoing = this.ongoing.then(() => Deno.writeAll(this.proc!.stdin!, body));
		return this.ongoing;
	}

	private read(): Promise<any>
	{	this.ongoing = this.ongoing.then(() => this.do_read());
		return this.ongoing;
	}

	private async do_read(): Promise<any>
	{	let buffer = new Uint8Array(4);
		await this.commands_io!.read(buffer);
		let [len] = new Int32Array(buffer.buffer);
		if (len == 0)
		{	return null;
		}
		let is_error = false;
		if (len < 0)
		{	if (len == -1)
			{	return; // undefined
			}
			is_error = true;
			len = -len;
		}
		buffer = new Uint8Array(len);
		let pos = 0;
		while (pos < len)
		{	let n_read = await this.commands_io!.read(buffer.subarray(pos));
			pos += n_read!;
		}
		if (is_error)
		{	let [file, line, message, trace] = JSON.parse(this.decoder.decode(buffer));
			line |= 0;
			throw new InterpreterError(message, file, line, trace);
		}
		return JSON.parse(this.decoder.decode(buffer));
	}

	exit()
	{	this.ongoing = this.ongoing.then(() => this.do_exit());
		return this.ongoing;
	}

	private async do_exit()
	{	this.proc?.stdin!.close();
		await this.proc?.status();
		this.proc?.close();
		this.commands_io?.close();
		this.socket?.close();
		let yes = await exists(SOCKET_NAME);
		if (yes)
		{	await Deno.remove(SOCKET_NAME);
		}
		this.proc = undefined;
		this.socket = undefined;
		this.commands_io = undefined;
	}
}

function get_proxy
(	path: string[],
	get: (path: string[]) => Promise<any>,
	set: (path: string[], value: any) => boolean,
	apply: (path: string[], args: IArguments) => Promise<any>,
	construct: (path: string[], args: IArguments) => Promise<any>
): any
{	return new Proxy
	(	function() {}, // if this is not a function, construct() and apply() will throw error
		{	get(_, prop_name)
			{	let promise: Promise<any>|undefined;
				if (prop_name == 'then')
				{	// case: await path
					if (!promise) promise = get(path);
					return (y: any, n: any) => promise!.then(y, n);
				}
				else if (prop_name == 'catch')
				{	// case: await path
					if (!promise) promise = get(path);
					return (n: any) => promise!.catch(n);
				}
				else if (prop_name == 'finally')
				{	// case: await path
					if (!promise) promise = get(path);
					return (y: any) => promise!.finally(y);
				}
				else if (typeof(prop_name) != 'string')
				{	// case: +path or path+''
					throw new Error(`Value must be awaited-for`);
				}
				else
				{	// case: path.prop_name
					return get_proxy(path.concat([prop_name]), get, set, apply, construct);
				}
			},
			set(_, prop_name, value) // set static class variable
			{	// case: path.prop_name = value
				if (typeof(prop_name) != 'string')
				{	throw new Error('Cannot use such object like this');
				}
				return set(path.concat([prop_name]), value);
			},
			apply(_, proxy, args)
			{	// case: path(args)
				return apply(path, args);
			},
			construct(_, args) // new Class
			{	// case: new path
				return construct(path, args);
			}
		}
	);
}

var php_singleton = new PhpInterpreter;
export var g = php_singleton.g;
export var c = php_singleton.c;
