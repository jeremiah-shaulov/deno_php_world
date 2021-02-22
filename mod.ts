import {PHP_INIT} from './php-init.ts';
import {exists} from "https://deno.land/std/fs/mod.ts";

const PHP_CLI_NAME_DEFAULT = 'php';
const SOCKET_NAME_DEFAULT = '/tmp/deno-php-commands-io';
const ASSERTIONS_ENABLED = true;
const DEBUG_PHP_INIT = false;

const REC_HELO = 0;
const REC_CONST = 1;
const REC_GET = 2;
const REC_SET = 3;
const REC_SET_PATH = 4;
const REC_UNSET = 5;
const REC_CLASSSTATIC_GET = 6;
const REC_CLASSSTATIC_SET = 7;
const REC_CLASSSTATIC_SET_PATH = 8;
const REC_CLASSSTATIC_UNSET = 9;
const REC_CONSTRUCT = 10;
const REC_DESTRUCT = 11;
const REC_CLASS_GET = 12;
const REC_CLASS_SET = 13;
const REC_CLASS_CALL = 14;
const REC_CALL = 15;
const REC_CALL_THIS = 16;
const REC_CALL_EVAL = 17;
const REC_CALL_EVAL_THIS = 18;
const REC_CALL_ECHO = 19;
const REC_CALL_INCLUDE = 20;
const REC_CALL_INCLUDE_ONCE = 21;
const REC_CALL_REQUIRE = 22;
const REC_CALL_REQUIRE_ONCE = 23;

const RE_BAD_CLASSNAME_FOR_EVAL = /[^\w\\]/;

function assert(expr: unknown): asserts expr
{	if (ASSERTIONS_ENABLED && !expr)
	{	throw new Error('Assertion failed');
	}
}

async function get_random_key(): Promise<string>
{	if (await exists('/dev/urandom'))
	{	let fh = await Deno.open('/dev/urandom', {read: true});
		let buffer = new Uint8Array(32);
		try
		{	let pos = 0;
			while (pos < 32)
			{	let n_read = await fh.read(buffer.subarray(pos));
				pos += n_read!;
			}
		}
		finally
		{	fh.close();
		}
		return btoa(String.fromCharCode.apply(null, buffer as any));
	}
	return String(Math.random());
}

export class InterpreterError extends Error
{	constructor(public message: string, public file: string, public line: number, public trace: string)
	{	super(message);
	}
}

export class PhpInterpreter
{	public g: any;
	public c: any;
	public settings = {php_cli_name: PHP_CLI_NAME_DEFAULT, socket: SOCKET_NAME_DEFAULT};

	private proc: Deno.Process|undefined;
	private socket: Deno.Listener|undefined;
	private commands_io: Deno.Conn|undefined;
	private is_initing = false;
	private using_unix_socket = '';
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

							// deleteProperty
							path =>
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
									path_str += ' '+JSON.stringify(path.slice(1));
									record_type = REC_UNSET;
								}
								else
								{	// case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i<=0 || var_i==path.length-1)
									{	throw new Error(`Cannot unset this object: ${path.join('.')}`);
									}
									path_str = path.slice(0, var_i).join('\\');
									if (RE_BAD_CLASSNAME_FOR_EVAL.test(path_str))
									{	throw new Error(`Cannot use such class name: ${path_str}`);
									}
									if (path[var_i].indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
									}
									path_str += ' '+path[var_i].slice(1); // cut '$'
									path_str += ' '+JSON.stringify(path.slice(var_i+1));
									record_type = REC_CLASSSTATIC_UNSET;
								}
								php.write(record_type, path_str);
								return true;
							},

							// apply
							(path, args) =>
							{	// case: function
								let path_str = '';
								let record_type = REC_CALL;
								if (!is_class)
								{	if (path.length == 1)
									{	// case: func_name()
										path_str = path[0];
										switch (path_str.toLowerCase())
										{	case 'exit':
												return php.exit();
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
								if (record_type!=REC_CALL && record_type!=REC_CALL_EVAL)
								{	return php.write(record_type, path_str).then(() => php.read());
								}
								else
								{	let promise: Promise<any>|undefined;
									return new Proxy
									(	php,
										{	get(php, prop_name)
											{	if (prop_name == 'this')
												{	return php.write(record_type==REC_CALL_EVAL ? REC_CALL_EVAL_THIS : REC_CALL_THIS, path_str).then(() => php.read()).then(h_inst => construct(php, h_inst|0));
												}
												else if (prop_name == 'then')
												{	if (!promise) promise = php.write(record_type, path_str).then(() => php.read());
													return (y: any, n: any) => promise!.then(y, n);
												}
												else if (prop_name == 'catch')
												{	if (!promise) promise = php.write(record_type, path_str).then(() => php.read());
													return (n: any) => promise!.catch(n);
												}
												else if (prop_name == 'finally')
												{	if (!promise) promise = php.write(record_type, path_str).then(() => php.read());
													return (y: any) => promise!.finally(y);
												}
												else
												{	throw new Error(`Result of function call must be awaited-for`);
												}
											}
										}
									);
								}
							},

							// construct
							async (path, args) =>
							{	let class_name = path.join('\\');
								await php.write(REC_CONSTRUCT, args.length==0 ? class_name : class_name+' '+JSON.stringify([...args]));
								let h_inst = (await php.read())|0;
								return construct(php, h_inst);
							}
						);
					},

					set(php, prop_name, value)
					{	if (typeof(prop_name) != 'string')
						{	throw new Error('Cannot assign to this object');
						}
						if (is_class)
						{	throw new Error(`Cannot assign to class: ${prop_name}`);
						}
						if (prop_name.charAt(0) != '$')
						{	throw new Error(`Invalid global variable name: ${prop_name}`);
						}
						prop_name = prop_name.slice(1); // cut '$'
						if (prop_name.indexOf(' ') != -1)
						{	throw new Error(`Variable name must not contain spaces: $${prop_name}`);
						}
						php.write(REC_SET, value==null ? prop_name : prop_name+' '+JSON.stringify(value));
						return true;
					},

					deleteProperty(php, prop_name)
					{	if (typeof(prop_name) != 'string')
						{	throw new Error('Cannot delete this object');
						}
						if (is_class)
						{	throw new Error(`Cannot delete a class: ${prop_name}`);
						}
						if (prop_name.charAt(0) != '$')
						{	throw new Error(`Invalid global variable name: ${prop_name}`);
						}
						prop_name = prop_name.slice(1); // cut '$'
						if (prop_name.indexOf(' ') != -1)
						{	throw new Error(`Variable name must not contain spaces: $${prop_name}`);
						}
						php.write(REC_UNSET, prop_name);
						return true;
					}
				}
			);
		}

		function construct(php: PhpInterpreter, h_inst: number)
		{	return new Proxy
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
									{	throw new Error(`Instance property "${prop_name}": value must be awaited-for`);
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
	}

	private async init()
	{	// 1. Open a socket, and start listening
		let php_socket;
		if (Deno.build.os != 'windows')
		{	this.using_unix_socket = this.settings.socket;
			this.socket = Deno.listen({transport: 'unix', path: this.settings.socket});
			php_socket = 'unix://'+this.settings.socket;
		}
		else
		{	this.using_unix_socket = '';
			this.socket = Deno.listen({transport: 'tcp', hostname: '127.0.0.1', port: 0});
			php_socket = 'tcp://127.0.0.1:'+(this.socket.addr as Deno.NetAddr).port;
		}
		// 2. Run the PHP interpreter
		let cmd = DEBUG_PHP_INIT ? [this.settings.php_cli_name, 'php-init.ts'] : [this.settings.php_cli_name, '-r', PHP_INIT.slice('<?php\n\n'.length)];
		if (Deno.args.length)
		{	cmd.splice(cmd.length, 0, '--', ...Deno.args);
		}
		this.proc = Deno.run({cmd, stdin: 'piped', stdout: 'inherit', stderr: 'inherit'});
		// 3. Generate random key
		let key = await get_random_key();
		// 4. Send the HELO packet with opened socket address and the key
		let helo = this.encoder.encode('01230123'+JSON.stringify([php_socket, key]));
		let len = new DataView(helo.buffer);
		len.setInt32(0, REC_HELO);
		len.setInt32(4, helo.length - 8);
		await Deno.writeAll(this.proc!.stdin!, helo);
		// 5. Accept connection from the interpreter. Identify it by the key.
		while (true)
		{	this.commands_io = await this.socket.accept();
			try
			{	let helo = await this.do_read();
				if (helo == key)
				{	break;
				}
			}
			catch (e)
			{	console.error(e);
			}
			this.commands_io.close();
		}
		// 6. Done
		this.is_initing = false;
	}

	private write(record_type: number, str: string)
	{	let body = this.encoder.encode('01230123'+str);
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
		if (this.using_unix_socket)
		{	let yes = await exists(this.using_unix_socket);
			if (yes)
			{	await Deno.remove(this.using_unix_socket);
			}
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
	deleteProperty: (path: string[]) => boolean,
	apply: (path: string[], args: IArguments) => any,
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
					return get_proxy(path.concat([prop_name]), get, set, deleteProperty, apply, construct);
				}
			},
			set(_, prop_name, value) // set static class variable
			{	// case: path.prop_name = value
				if (typeof(prop_name) != 'string')
				{	throw new Error('Cannot use such object like this');
				}
				return set(path.concat([prop_name]), value);
			},
			deleteProperty(_, prop_name)
			{	if (typeof(prop_name) != 'string')
				{	throw new Error('Cannot use such object like this');
				}
				return deleteProperty(path.concat([prop_name]));
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

const php = new PhpInterpreter;
export const g = php.g;
export const c = php.c;
export const settings = php.settings;
