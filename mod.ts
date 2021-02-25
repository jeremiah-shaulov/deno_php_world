import {PHP_INIT} from './php-init.ts';
import {exists} from "https://deno.land/std/fs/mod.ts";

const PHP_CLI_NAME_DEFAULT = 'php';
const SOCKET_NAME_DEFAULT = '/tmp/deno-php-commands-io';
const ASSERTIONS_ENABLED = true;
const DEBUG_PHP_INIT = false;

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
const REC_CALL = 25;
const REC_CALL_THIS = 26;
const REC_CALL_EVAL = 27;
const REC_CALL_EVAL_THIS = 28;
const REC_CALL_ECHO = 29;
const REC_CALL_INCLUDE = 30;
const REC_CALL_INCLUDE_ONCE = 31;
const REC_CALL_REQUIRE = 32;
const REC_CALL_REQUIRE_ONCE = 33;

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

export class InterpreterError extends Error
{	constructor(public message: string, public fileName: string, public lineNumber: number, public trace: string)
	{	super(message);
	}
}

export class PhpInterpreter
{	public g: any;
	public c: any;
	public settings = {php_cli_name: PHP_CLI_NAME_DEFAULT, unix_socket_name: SOCKET_NAME_DEFAULT};

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
											await php.write(record_type, path_str);
											return await php.read();
										};
									}
									else if (path[0].charAt(0) != '$')
									{	// case: A\B\C
										let path_str = path.join('\\');
										return async function(prop_name)
										{	await php.write(REC_CONST, path_str+'\\'+prop_name);
											return await php.read();
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
												await php.write(REC_GET, path_str+' '+JSON.stringify(path_2));
												return await php.read();
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												await php.write(REC_GET_THIS, path_str);
												return construct(php, await php.read());
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
											await php.write(record_type, path_str_2);
											return await php.read();
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
												await php.write(REC_CLASSSTATIC_GET, path_str+' '+JSON.stringify(path_2));
												return await php.read();
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												await php.write(REC_CLASSSTATIC_GET_THIS, path_str);
												return construct(php, await php.read());
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
																await php.write(REC_CALL_EVAL_THIS, path_str);
																return construct(php, await php.read());
															}
														}
													);
													return promise;
												};
											case 'echo':
												return async function(args)
												{	await php.write(REC_CALL_ECHO, JSON.stringify([...args]));
													return await php.read();
												};
											case 'include':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include()');
													}
													await php.write(REC_CALL_INCLUDE, JSON.stringify(args[0]));
													return await php.read();
												};
											case 'include_once':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include_once()');
													}
													await php.write(REC_CALL_INCLUDE_ONCE, JSON.stringify(args[0]));
													return await php.read();
												};
											case 'require':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require()');
													}
													await php.write(REC_CALL_REQUIRE, JSON.stringify(args[0]));
													return await php.read();
												};
											case 'require_once':
												return async function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require_once()');
													}
													await php.write(REC_CALL_REQUIRE_ONCE, JSON.stringify(args[0]));
													return await php.read();
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
												await php.write(REC_CALL_THIS, path_str_2);
												return construct(php, await php.read());
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
								{	await php.write(REC_CONSTRUCT, args.length==0 ? class_name : class_name+' '+JSON.stringify([...args]));
									return construct(php, await php.read(), class_name);
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

		function construct(php: PhpInterpreter, result: string, class_name=''): any
		{	if (!class_name)
			{	let pos = result.indexOf(' ');
				if (pos != -1)
				{	class_name = result.slice(pos+1);
					result = result.slice(0, pos);
				}
			}
			let inst_id = Number(result);
			return get_proxy
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
							await php.write(REC_CLASS_GET, path_str+prop_name);
							return await php.read();
						};
					}
					else
					{	let path_str = inst_id+' '+path[0];
						let path_2 = path.slice(1).concat(['']);
						return async function(prop_name)
						{	if (prop_name != 'this')
							{	path_2[path_2.length-1] = prop_name;
								await php.write(REC_CLASS_GET, path_str+' '+JSON.stringify(path_2));
								return await php.read();
							}
							else
							{	if (path_2.length >= 2)
								{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
								}
								await php.write(REC_CLASS_GET_THIS, path_str);
								return construct(php, await php.read());
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
							{	await php.write(REC_CLASS_CALL, args.length==0 ? path_str : path_str+' '+JSON.stringify([...args]));
								return await php.read();
							};
						}
					}
					else
					{	if (path[path.length-1].indexOf(' ') != -1)
						{	throw new Error(`Function name must not contain spaces: ${path[path.length-1]}`);
						}
						let path_str = inst_id+' '+path[path.length-1]+' ['+JSON.stringify(path.slice(0, -1))+',';
						return async function(args)
						{	await php.write(REC_CLASS_CALL_PATH, path_str+JSON.stringify([...args])+']');
							return await php.read();
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
					{	await php.write(REC_CLASS_ITERATE_BEGIN, path_str);
						let [value, done] = await php.read();
						while (true)
						{	if (done)
							{	return;
							}
							yield value;
							await php.write(REC_CLASS_ITERATE, path_str);
							[value, done] = await php.read();
						}
					};
				}
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
		this.proc = Deno.run({cmd, stdin: 'piped', stdout: 'inherit', stderr: 'inherit'});
		// 3. Generate random key
		let key = await get_random_key();
		// 4. Send the HELO packet with opened socket address and the key
		this.do_write(REC_HELO, JSON.stringify([php_socket, key]));
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

	private schedule(callback: () => any)
	{	if (!this.commands_io && !this.is_initing)
		{	this.is_initing = true;
			this.schedule(() => this.init());
		}
		this.ongoing = this.ongoing.then(callback);
		queueMicrotask(() => {this.ongoing = this.ongoing.catch(() => {})});
		return this.ongoing;
	}

	private write(record_type: number, str: string)
	{	return this.schedule(() => this.do_write(record_type, str));
	}

	private read(): Promise<any>
	{	return this.schedule(() => this.do_read());
	}

	exit()
	{	return this.schedule(() => this.do_exit());
	}

	private async do_write(record_type: number, str: string)
	{	let body = this.encoder.encode('01230123'+str);
		let len = new DataView(body.buffer);
		len.setInt32(0, record_type);
		len.setInt32(4, body.length - 8);
		await Deno.writeAll(this.proc!.stdin!, body);
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
			throw new InterpreterError(message, file, Number(line), trace);
		}
		return JSON.parse(this.decoder.decode(buffer));
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

type ProxyGetterForPath = (prop_name: string) => Promise<any>;
type ProxySetterForPath = (prop_name: string, value: any) => boolean;
type ProxyDeleterForPath = (prop_name: string) => boolean;
type ProxyApplierForPath = (args: IArguments) => any;
type ProxyHasInstanceForPath = (inst: Object) => boolean;
type ProxyIteratorForPath = () => AsyncGenerator<any>;

function get_proxy
(	path: string[],
	string_tag: string,
	get_getter: (path: string[]) => ProxyGetterForPath,
	get_setter: (path: string[]) => ProxySetterForPath,
	get_deleter: (path: string[]) => ProxyDeleterForPath,
	get_applier: (path: string[]) => ProxyApplierForPath,
	get_constructor: (path: string[]) => ProxyApplierForPath,
	get_has_instance: (path: string[]) => ProxyHasInstanceForPath,
	get_iterator: (path: string[]) => ProxyIteratorForPath
)
{	return inst(path, {getter: undefined});
	function inst
	(	path: string[],
		parent_getter: {getter: ProxyGetterForPath | undefined}
	): any
	{	let promise: Promise<any> | undefined;
		let for_getter = {getter: undefined};
		let setter: ProxySetterForPath | undefined;
		let deleter: ProxyDeleterForPath | undefined;
		let applier: ProxyApplierForPath | undefined;
		let constructor: ProxyApplierForPath | undefined;
		let has_instance: ProxyHasInstanceForPath | undefined;
		let iterator: ProxyIteratorForPath | undefined;
		return new Proxy
		(	function() {}, // if this is not a function, construct() and apply() will throw error
			{	get(_, prop_name)
				{	if (typeof(prop_name) != 'string')
					{	// case: +path or path+''
						if (prop_name==symbol_php_object || prop_name==Symbol.toStringTag)
						{	return string_tag;
						}
						else if (prop_name == Symbol.hasInstance)
						{	if (!has_instance)
							{	has_instance = get_has_instance(path);
							}
							return has_instance;
						}
						else if (prop_name == Symbol.asyncIterator)
						{	if (!iterator)
							{	iterator = get_iterator(path);
							}
							return iterator;
						}
						throw new Error(`Value must be awaited-for`);
					}
					else if (prop_name=='then' || prop_name=='catch' || prop_name=='finally')
					{	// case: await path
						if (path.length == 0)
						{	return; // not thenable
						}
						if (!parent_getter.getter)
						{	parent_getter.getter = get_getter(path.slice(0, -1));
						}
						if (!promise)
						{	promise = parent_getter.getter(path[path.length-1]);
						}
						if (prop_name == 'then')
						{	return (y: any, n: any) => promise!.then(y, n);
						}
						else if (prop_name == 'catch')
						{	return (n: any) => promise!.catch(n);
						}
						else
						{	return (y: any) => promise!.finally(y);
						}
					}
					else
					{	// case: path.prop_name
						return inst(path.concat([prop_name]), for_getter);
					}
				},
				set(_, prop_name, value) // set static class variable
				{	// case: path.prop_name = value
					if (typeof(prop_name) != 'string')
					{	throw new Error('Cannot use such object like this');
					}
					if (!setter)
					{	setter = get_setter(path);
					}
					return setter(prop_name, value);
				},
				deleteProperty(_, prop_name)
				{	if (typeof(prop_name) != 'string')
					{	throw new Error('Cannot use such object like this');
					}
					if (!deleter)
					{	deleter = get_deleter(path);
					}
					return deleter(prop_name);
				},
				apply(_, proxy, args)
				{	// case: path(args)
					if (!applier)
					{	applier = get_applier(path);
					}
					return applier(args);
				},
				construct(_, args) // new Class
				{	// case: new path
					if (!constructor)
					{	constructor = get_constructor(path);
					}
					return constructor(args);
				}
			}
		);
	}
}

const php = new PhpInterpreter;
export const g = php.g;
export const c = php.c;
export const settings = php.settings;
