import {PHP_INIT} from './php-init.ts';
import {create_proxy} from './proxy_object.ts';
import {ReaderMux} from './reader_mux.ts';
import {exists} from "https://deno.land/std/fs/mod.ts";

const PHP_CLI_NAME_DEFAULT = 'php';
const SOCKET_NAME_DEFAULT = '/tmp/deno-php-commands-io';
const ASSERTIONS_ENABLED = true;
const DEBUG_PHP_INIT = false;
const READER_MUX_END_MARK_LEN = 32;

const REC_HELO = 0;
const REC_CONST = 1;
const REC_GET = 2;
const REC_GET_THIS = 3;
const REC_SET = 4;
const REC_SET_PATH = 5;
const REC_UNSET = 6;
const REC_UNSET_PATH = 7;
const REC_CLASSSTATIC_GET = 8;
const REC_CLASSSTATIC_GET_THIS = 9;
const REC_CLASSSTATIC_SET = 10;
const REC_CLASSSTATIC_SET_PATH = 11;
const REC_CLASSSTATIC_UNSET = 12;
const REC_CONSTRUCT = 13;
const REC_DESTRUCT = 14;
const REC_CLASS_GET = 15;
const REC_CLASS_GET_THIS = 16;
const REC_CLASS_SET = 17;
const REC_CLASS_SET_PATH = 18;
const REC_CLASS_UNSET = 19;
const REC_CLASS_UNSET_PATH = 20;
const REC_CLASS_CALL = 21;
const REC_CLASS_CALL_PATH = 22;
const REC_CLASS_ITERATE_BEGIN = 23;
const REC_CLASS_ITERATE = 24;
const REC_POP_FRAME = 25;
const REC_N_OBJECTS = 26;
const REC_END_STDOUT = 27;
const REC_CALL = 28;
const REC_CALL_THIS = 29;
const REC_CALL_EVAL = 30;
const REC_CALL_EVAL_THIS = 31;
const REC_CALL_ECHO = 32;
const REC_CALL_INCLUDE = 33;
const REC_CALL_INCLUDE_ONCE = 34;
const REC_CALL_REQUIRE = 35;
const REC_CALL_REQUIRE_ONCE = 36;

const RE_BAD_CLASSNAME_FOR_EVAL = /[^\w\\]/;

let symbol_php_object = Symbol();

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

function get_weak_random_bytes(n: number)
{	let buffer = new Uint8Array(n);
	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = Math.floor(Math.random()*256);
	}
	return buffer;
}

export class InterpreterError extends Error
{	constructor(public message: string, public fileName: string, public lineNumber: number, public trace: string)
	{	super(message);
	}
}

export class InterpreterExitError extends Error
{	constructor(public message: string, public code: number)
	{	super(message);
	}
}

class Settings
{	public php_cli_name = PHP_CLI_NAME_DEFAULT;
	public unix_socket_name = SOCKET_NAME_DEFAULT;
	public stdout: 'inherit'|'piped'|'null'|number = 'inherit';
}

export class PhpInterpreter
{	public g: any;
	public c: any;
	public settings = new Settings;

	private proc: Deno.Process|undefined;
	private socket: Deno.Listener|undefined;
	private commands_io: Deno.Conn|undefined;
	private is_initing = false;
	private using_unix_socket = '';
	private ongoing: Promise<unknown> = Promise.resolve();
	private stdout_mux: ReaderMux|undefined;
	private last_inst_id = -1;
	private stack_frames: number[] = [];
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
						return create_proxy
						(	[prop_name],
							'',

							// get
							path =>
							{	if (!is_class)
								{	// case: A\B\C
									// or case: $var
									// or case: $var['a']['b']
									if (path.length == 0)
									{	// case: C
										// or case: $var
										return async function(prop_name)
										{	let record_type = REC_CONST;
											let path_str = prop_name;
											if (prop_name.charAt(0) == '$')
											{	path_str = path_str.slice(1); // cut '$'
												record_type = REC_GET;
											}
											return await php.write_read(record_type, path_str);
										};
									}
									else if (path[0].charAt(0) != '$')
									{	// case: A\B\C
										let path_str = path.join('\\');
										return async function(prop_name)
										{	return await php.write_read(REC_CONST, path_str+'\\'+prop_name);
										};
									}
									else
									{	let path_str = path[0].slice(1); // cut '$'
										if (path_str.indexOf(' ') != -1)
										{	throw new Error(`Variable name must not contain spaces: $${path_str}`);
										}
										let path_2 = path.slice(1).concat(['']);
										return async function(prop_name)
										{	if (prop_name != 'this')
											{	path_2[path_2.length-1] = prop_name;
												return await php.write_read(REC_GET, path_str+' '+JSON.stringify(path_2));
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												return construct(php, await php.write_read(REC_GET_THIS, path_str));
											}
										};
									}
								}
								else
								{	// case: A\B::C
									// or case: A\B::$c
									// or case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i == -1)
									{	// case: A\B::C
										// or case: A\B::$c
										let path_str = path.join('\\');
										if (path_str.indexOf(' ') != -1)
										{	throw new Error(`Class/namespace names must not contain spaces: ${path_str}`);
										}
										return async function(prop_name)
										{	let record_type = REC_CONST;
											let path_str_2 = path_str;
											if (prop_name.charAt(0) != '$')
											{	path_str_2 += '::'+prop_name;
											}
											else
											{	record_type = REC_CLASSSTATIC_GET;
												if (prop_name.indexOf(' ') != -1)
												{	throw new Error(`Variable name must not contain spaces: ${path_str_2}::${prop_name}`);
												}
												path_str_2 += ' '+prop_name.slice(1); // cut '$'
											}
											return await php.write_read(record_type, path_str_2);
										};
									}
									else if (var_i == 0)
									{	throw new Error(`Invalid object usage: ${path.join('.')}`);
									}
									else
									{	// case: A\B::$c (.this)
										// or case: A\B::$c['d']['e']
										let path_str = path.slice(0, var_i).join('\\');
										if (path_str.indexOf(' ') != -1)
										{	throw new Error(`Class/namespace names must not contain spaces: ${path_str}`);
										}
										if (path[var_i].indexOf(' ') != -1)
										{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
										}
										path_str += ' '+path[var_i].slice(1); // cut '$'
										let path_2 = path.slice(var_i+1).concat(['']);
										return async function(prop_name)
										{	if (prop_name != 'this')
											{	path_2[path_2.length-1] = prop_name;
												return await php.write_read(REC_CLASSSTATIC_GET, path_str+' '+JSON.stringify(path_2));
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												return construct(php, await php.write_read(REC_CLASSSTATIC_GET_THIS, path_str));
											}
										};
									}
								}
							},

							// set
							path =>
							{	if (!is_class)
								{	// case: $var['a']['b']
									if (path[0].charAt(0) != '$')
									{	throw new Error(`Cannot set this object: ${path.join('.')}`);
									}
									let path_str = path[0].slice(1); // cut '$'
									if (path_str.indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: $${path_str}`);
									}
									path_str += ' [';
									if (path.length > 1)
									{	path_str += JSON.stringify(path.slice(1)).slice(0, -1)+',';
									}
									else
									{	path_str += '[';
									}
									return function(prop_name, value)
									{	php.write(REC_SET_PATH, path_str+JSON.stringify(prop_name)+'],'+JSON.stringify(value)+']');
										return true;
									};
								}
								else
								{	// case: A\B::$c
									// or case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i == 0)
									{	throw new Error(`Cannot set this object: ${path.join('.')}`);
									}
									if (var_i == -1)
									{	var_i = path.length; // prop_name (see below) must be a var name
										let path_str = path.slice(0, var_i).join('\\');
										if (RE_BAD_CLASSNAME_FOR_EVAL.test(path_str))
										{	throw new Error(`Cannot use such class name: ${path_str}`);
										}
										path_str += ' ';
										let path_2 = path.concat(['']);
										return function(prop_name, value)
										{	path_2[path_2.length-1] = prop_name;
											if (path_2[var_i].indexOf(' ') != -1)
											{	throw new Error(`Variable name must not contain spaces: ${path_2[var_i]}`);
											}
											let path_str_2 = path_str+path_2[var_i].slice(1); // cut '$'
											if (prop_name.charAt(0) != '$')
											{	throw new Error(`Cannot set this object: ${path_2.join('.')}`);
											}
											if (value != null)
											{	path_str_2 += ' '+JSON.stringify(value);
											}
											php.write(REC_CLASSSTATIC_SET, path_str_2);
											return true;
										};
									}
									else
									{	let path_str = path.slice(0, var_i).join('\\');
										if (RE_BAD_CLASSNAME_FOR_EVAL.test(path_str))
										{	throw new Error(`Cannot use such class name: ${path_str}`);
										}
										if (path[var_i].indexOf(' ') != -1)
										{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
										}
										path_str += ' '+path[var_i].slice(1)+' ['; // cut '$'
										if (path.length > var_i+1)
										{	path_str += JSON.stringify(path.slice(var_i+1)).slice(0, -1)+',';
										}
										else
										{	path_str += '[';
										}
										return function(prop_name, value)
										{	php.write(REC_CLASSSTATIC_SET_PATH, path_str+JSON.stringify(prop_name)+'],'+JSON.stringify(value)+']');
											return true;
										};
									}
								}
							},

							// deleteProperty
							path =>
							{	if (!is_class)
								{	// case: $var['a']['b']
									if (path[0].charAt(0) != '$')
									{	throw new Error(`Cannot set this object: ${path.join('.')}`);
									}
									let path_str = path[0].slice(1); // cut '$'
									if (path_str.indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: $${path_str}`);
									}
									path_str += ' ';
									let path_str_2 = path.length==1 ? '' : ' '+JSON.stringify(path.slice(1));
									return function(prop_name)
									{	php.write(REC_UNSET_PATH, path_str+prop_name+path_str_2);
										return true;
									};
								}
								else
								{	// case: A\B::$c['d']['e']
									let var_i = path.findIndex(p => p.charAt(0) == '$');
									if (var_i <= 0)
									{	throw new Error(`Cannot unset this object: ${path.join('.')}`);
									}
									let path_str = path.slice(0, var_i).join('\\');
									if (RE_BAD_CLASSNAME_FOR_EVAL.test(path_str))
									{	throw new Error(`Cannot use such class name: ${path_str}`);
									}
									if (path[var_i].indexOf(' ') != -1)
									{	throw new Error(`Variable name must not contain spaces: ${path[var_i]}`);
									}
									path_str += ' '+path[var_i].slice(1); // cut '$'
									path_str += ' ';
									let path_2 = path.slice(var_i+1).concat(['']);
									return function(prop_name)
									{	path_2[path_2.length-1] = prop_name;
										php.write(REC_CLASSSTATIC_UNSET, path_str+JSON.stringify(path_2));
										return true;
									};
								}
							},

							// apply
							path =>
							{	if (!is_class)
								{	if (path.length == 1)
									{	// case: func_name()
										switch (path[0].toLowerCase())
										{	case 'exit':
												return async function()
												{	return await php.exit();
												};
											case 'eval':
												return function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to eval()');
													}
													let path_str = JSON.stringify(args[0]);
													let is_this = false;
													let promise = php.schedule
													(	async () =>
														{	if (!is_this)
															{	await php.do_write(REC_CALL_EVAL, path_str);
																return await php.do_read();
															}
														}
													);
													Object.defineProperty
													(	promise,
														'this',
														{	async get()
															{	is_this = true;
																return construct(php, await php.write_read(REC_CALL_EVAL_THIS, path_str));
															}
														}
													);
													return promise;
												};
											case 'echo':
												return async function(args)
												{	return await php.write_read(REC_CALL_ECHO, JSON.stringify([...args]));
												};
											case 'include':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include()');
													}
													return await php.write_read(REC_CALL_INCLUDE, JSON.stringify(args[0]));
												};
											case 'include_once':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include_once()');
													}
													return await php.write_read(REC_CALL_INCLUDE_ONCE, JSON.stringify(args[0]));
												};
											case 'require':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require()');
													}
													return await php.write_read(REC_CALL_REQUIRE, JSON.stringify(args[0]));
												};
											case 'require_once':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require_once()');
													}
													return await php.write_read(REC_CALL_REQUIRE_ONCE, JSON.stringify(args[0]));
												};
										}
									}
								}
								let path_str = '';
								if (!is_class)
								{	// case: A\B\c()
									path_str = path.join('\\');
								}
								else if (path.length > 1)
								{	// case: A\B::c()
									path_str = path.slice(0, -1).join('\\')+'::'+path[path.length-1];
								}
								else
								{	// case: ClassName
									throw new Error(`Invalid class name usage: ${path[0]}`);
								}
								return function(args)
								{	let path_str_2 = path_str;
									if (args.length != 0)
									{	path_str_2 += ' '+JSON.stringify([...args]);
									}
									let is_this = false;
									let promise = php.schedule
									(	async () =>
										{	if (!is_this)
											{	await php.do_write(REC_CALL, path_str_2);
												return await php.do_read();
											}
										}
									);
									Object.defineProperty
									(	promise,
										'this',
										{	async get()
											{	is_this = true;
												return construct(php, await php.write_read(REC_CALL_THIS, path_str_2));
											}
										}
									);
									return promise;
								};
							},

							// construct
							path =>
							{	let class_name = path.join('\\');
								return async function(args)
								{	return construct(php, await php.write_read(REC_CONSTRUCT, args.length==0 ? class_name : class_name+' '+JSON.stringify([...args])), class_name);
								};
							},

							// hasInstance
							path =>
							{	if (is_class && path.length>0 && path.findIndex(p => p.charAt(0) == '$')==-1)
								{	let class_name = path.join('\\');
									return function(inst)
									{	if ((inst as any)[symbol_php_object] === class_name)
										{	return true;
										}
										return false;
									};
								}
								else
								{	return inst => false;
								}
							},

							// asyncIterator
							path =>
							{	return async function*()
								{	throw new Error('Object is not iterable');
								};
							},

							symbol_php_object
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

		function construct(php: PhpInterpreter, result: string, class_name=''): any
		{	if (!class_name)
			{	let pos = result.indexOf(' ');
				if (pos != -1)
				{	class_name = result.slice(pos+1);
					result = result.slice(0, pos);
				}
			}
			let inst_id = Number(result);
			php.last_inst_id = inst_id;
			return create_proxy
			(	[],
				class_name,

				// get
				path =>
				{	if (path.length == 0)
					{	let path_str = inst_id+' ';
						return async function(prop_name)
						{	if (prop_name.indexOf(' ') != -1)
							{	throw new Error(`Property name must not contain spaces: $${prop_name}`);
							}
							return await php.write_read(REC_CLASS_GET, path_str+prop_name);
						};
					}
					else
					{	let path_str = inst_id+' '+path[0];
						let path_2 = path.slice(1).concat(['']);
						return async function(prop_name)
						{	if (prop_name != 'this')
							{	path_2[path_2.length-1] = prop_name;
								return await php.write_read(REC_CLASS_GET, path_str+' '+JSON.stringify(path_2));
							}
							else
							{	if (path_2.length >= 2)
								{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
								}
								return construct(php, await php.write_read(REC_CLASS_GET_THIS, path_str));
							}
						};
					}
				},

				// set
				path =>
				{	if (path.length == 0)
					{	let path_str = inst_id+' ';
						return function(prop_name, value)
						{	if (prop_name.indexOf(' ') != -1)
							{	throw new Error(`Property name must not contain spaces: ${prop_name}`);
							}
							php.write(REC_CLASS_SET, value==null ? path_str+prop_name : path_str+prop_name+' '+JSON.stringify(value));
							return true;
						};
					}
					else
					{	let path_str = inst_id+' '+path[0]+' [';
						if (path.length > 1)
						{	path_str += JSON.stringify(path.slice(1)).slice(0, -1)+',';
						}
						else
						{	path_str += '[';
						}
						return function(prop_name, value)
						{	php.write(REC_CLASS_SET_PATH, path_str+JSON.stringify(prop_name)+'],'+JSON.stringify(value)+']');
							return true;
						};
					}
				},

				// deleteProperty
				path =>
				{	if (path.length == 0)
					{	let path_str = inst_id+'';
						return function(prop_name)
						{	if (prop_name == 'this')
							{	php.write(REC_DESTRUCT, path_str);
								return true;
							}
							php.write(REC_CLASS_UNSET, path_str+' '+prop_name);
							return true;
						};
					}
					else
					{	let path_str = inst_id+' ';
						let path_str_2 = ' '+JSON.stringify(path);
						return function(prop_name)
						{	php.write(REC_CLASS_UNSET_PATH, path_str+prop_name+path_str_2);
							return true;
						};
					}
				},

				// apply
				path =>
				{	if (path.length == 0)
					{	throw new Error('Cannot use such object like this');
					}
					if (path.length == 1)
					{	if (path[0] == 'toJSON')
						{	return function()
							{	return {DENO_PHP_WORLD_INST_ID: inst_id};
							};
						}
						else
						{	let path_str = inst_id+' '+path[0];
							return async function(args)
							{	return await php.write_read(REC_CLASS_CALL, args.length==0 ? path_str : path_str+' '+JSON.stringify([...args]));
							};
						}
					}
					else
					{	if (path[path.length-1].indexOf(' ') != -1)
						{	throw new Error(`Function name must not contain spaces: ${path[path.length-1]}`);
						}
						let path_str = inst_id+' '+path[path.length-1]+' ['+JSON.stringify(path.slice(0, -1))+',';
						return async function(args)
						{	return await php.write_read(REC_CLASS_CALL_PATH, path_str+JSON.stringify([...args])+']');
						};
					}
				},

				// construct
				path =>
				{	throw new Error('Cannot construct such object');
				},

				// hasInstance
				path =>
				{	return inst => false;
				},

				// asyncIterator
				path =>
				{	let path_str = inst_id+'';
					return async function*()
					{	let [value, done] = await php.write_read(REC_CLASS_ITERATE_BEGIN, path_str);
						while (true)
						{	if (done)
							{	return;
							}
							yield value;
							[value, done] = await php.write_read(REC_CLASS_ITERATE, path_str);
						}
					};
				},

				symbol_php_object
			);
		}
	}

	private async init()
	{	// 1. Open a socket, and start listening
		let php_socket;
		if (this.settings.unix_socket_name && Deno.build.os!='windows')
		{	this.using_unix_socket = this.settings.unix_socket_name;
			this.socket = Deno.listen({transport: 'unix', path: this.settings.unix_socket_name});
			php_socket = 'unix://'+this.using_unix_socket;
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
		this.proc = Deno.run({cmd, stdin: 'piped', stdout: this.settings.stdout, stderr: 'inherit'});
		// 3. Generate random key
		let key = await get_random_key();
		let end_mark = get_weak_random_bytes(READER_MUX_END_MARK_LEN);
		// 4. Send the HELO packet with opened socket address and the key
		this.do_write(REC_HELO, JSON.stringify([php_socket, key, end_mark]));
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
		// 6. Mux stdout
		if (this.settings.stdout == 'piped')
		{	this.stdout_mux = new ReaderMux(this.proc.stdout!, end_mark);
		}
		// 7. Done
		this.is_initing = false;
	}

	private schedule<T>(callback: () => T | Promise<T>): Promise<T>
	{	if (!this.commands_io && !this.is_initing)
		{	this.is_initing = true;
			this.schedule(() => this.init());
		}
		let promise = this.ongoing.then(callback);
		this.ongoing = promise;
		queueMicrotask(() => {this.ongoing = this.ongoing.catch(() => {})});
		return promise;
	}

	private write(record_type: number, str: string)
	{	return this.schedule(() => this.do_write(record_type, str));
	}

	private write_read(record_type: number, str: string)
	{	return this.schedule(() => this.do_write(record_type, str).then(() => this.do_read()));
	}

	private exit()
	{	return this.schedule(() => this.do_exit());
	}

	push_frame()
	{	this.schedule(() => this.do_push_frame());
	}

	pop_frame()
	{	this.schedule(() => this.do_pop_frame());
	}

	n_objects()
	{	return this.schedule(() => this.do_n_objects());
	}

	get_stdout_reader()
	{	return this.schedule(() => this.do_get_stdout_reader());
	}

	drop_stdout_reader()
	{	return this.schedule(() => this.do_drop_stdout_reader());
	}

	private async do_write(record_type: number, str: string)
	{	let body = this.encoder.encode('01230123'+str);
		let len = new DataView(body.buffer);
		len.setInt32(0, record_type);
		len.setInt32(4, body.length - 8);
		if (this.stdout_mux && !this.stdout_mux.is_reading)
		{	this.stdout_mux.set_writer(Deno.stdout);
		}
		await Deno.writeAll(this.proc!.stdin!, body);
	}

	private async do_read(): Promise<any>
	{	let buffer = new Uint8Array(4);
		let pos = 0;
		while (pos < 4)
		{	let n_read = await this.commands_io!.read(buffer);
			if (n_read == null)
			{	this.exit_status_to_exception(await this.do_exit(true));
			}
			pos += n_read;
		}
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
		pos = 0;
		while (pos < len)
		{	let n_read = await this.commands_io!.read(buffer.subarray(pos));
			if (n_read == null)
			{	this.exit_status_to_exception(await this.do_exit(true));
			}
			pos += n_read;
		}
		if (is_error)
		{	let [file, line, message, trace] = JSON.parse(this.decoder.decode(buffer));
			throw new InterpreterError(message, file, Number(line), trace);
		}
		return JSON.parse(this.decoder.decode(buffer));
	}

	private async do_exit(is_eof=false)
	{	await this.do_drop_stdout_reader(is_eof);
		this.proc?.stdin!.close();
		if (this.stdout_mux)
		{	this.proc?.stdout!.close();
			this.stdout_mux = undefined;
		}
		let status = await this.proc?.status();
		this.proc?.close();
		this.commands_io?.close();
		this.socket?.close();
		if (this.using_unix_socket)
		{	let yes = await exists(this.using_unix_socket);
			if (yes)
			{	try
				{	await Deno.remove(this.using_unix_socket);
				}
				catch (e)
				{	console.error(e);
				}
			}
		}
		this.proc = undefined;
		this.socket = undefined;
		this.commands_io = undefined;
		this.last_inst_id = -1;
		this.stack_frames.length = 0;
		return status;
	}

	private exit_status_to_exception(status: {code: number} | undefined): never
	{	let code = status?.code ?? -1;
		let message = code==-1 ? 'PHP interpreter died' : code!=0 ? `PHP interpreter died with error code ${code}` : 'PHP interpreter exited';
		throw new InterpreterExitError(message, code);
	}

	private async do_push_frame()
	{	this.stack_frames.push(this.last_inst_id);
	}

	private async do_pop_frame()
	{	let last_inst_id = this.stack_frames.pop();
		if (last_inst_id === undefined)
		{	throw new Error('No frames to pop');
		}
		await this.do_write(REC_POP_FRAME, last_inst_id+'');
		this.last_inst_id = last_inst_id;
	}

	private async do_n_objects()
	{	await this.do_write(REC_N_OBJECTS, '');
		return await this.do_read();
	}

	private async do_get_stdout_reader(): Promise<Deno.Reader>
	{	if (!this.stdout_mux)
		{	throw new Error("Set settings.stdout to 'piped' to be able to redirect stdout");
		}
		return await this.stdout_mux.get_reader();
	}

	private async do_drop_stdout_reader(is_eof=false)
	{	if (this.stdout_mux)
		{	if (this.stdout_mux.is_reading && !is_eof)
			{	await this.do_write(REC_END_STDOUT, '');
			}
			await this.stdout_mux.set_none();
		}
	}
}

export const php = new PhpInterpreter;
export const {g, c, settings} = php;
