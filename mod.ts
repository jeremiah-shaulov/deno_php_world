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
const REC_CLASSSTATIC_CONST = 3;
const REC_CLASSSTATIC_GET = 4;
const REC_CLASSSTATIC_SET = 5;
const REC_CLASSSTATIC_CALL = 6;
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
	public f: any;
	public c: any;

	private proc: Deno.Process|undefined;
	private socket: Deno.Listener|undefined;
	private commands_io: Deno.Conn|undefined;
	private ongoing: Promise<void>|undefined;
	private encoder = new TextEncoder;
	private decoder = new TextDecoder;

	constructor()
	{	this.g = new Proxy
		(	this,
			{	async get(php, prop_name)
				{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>129 || prop_name.indexOf(' ')!=-1)
					{	throw new Error('Invalid function name');
					}
					let record_type = REC_CONST;
					if (prop_name.charAt(0) == '$')
					{	prop_name = prop_name.slice(1);
						record_type = REC_GET;
					}
					await php.write(record_type, prop_name);
					return await php.read();
				},
				set(php, prop_name, value)
				{	if (typeof(prop_name)!='string' || prop_name.length<2 || prop_name.length>129 || prop_name.indexOf(' ')!=-1 || prop_name.charAt(0)!='$')
					{	throw new Error('Invalid static property name');
					}
					prop_name = prop_name.slice(1); // cut '$'
					let job = php.write(REC_SET, value==null ? prop_name : prop_name+' '+JSON.stringify(value));
					assert(!php.ongoing); // write() must take the ongoing job
					php.ongoing = job;
					return true;
				}
			}
		);

		this.f = new Proxy
		(	this,
			{	get(php, func_name)
				{	if (typeof(func_name)!='string' || func_name.length==0 || func_name.length>128 || func_name.indexOf(' ')!=-1)
					{	throw new Error('Invalid function name');
					}
					switch (func_name.toLowerCase())
					{	case 'exit': return async function()
						{	await php.exit();
						};
						case 'eval': return async function()
						{	if (arguments.length != 1)
							{	throw new Error('Invalid number of arguments to eval()');
							}
							await php.write(REC_CALL_EVAL, JSON.stringify(arguments[0]));
							return await php.read();
						};
						case 'echo': return async function()
						{	await php.write(REC_CALL_ECHO, JSON.stringify([...arguments]));
							return await php.read(); // can either return null, or throw an error
						};
						case 'include': return async function()
						{	if (arguments.length != 1)
							{	throw new Error('Invalid number of arguments to include()');
							}
							await php.write(REC_CALL_INCLUDE, JSON.stringify(arguments[0]));
							return await php.read();
						};
						case 'include_once': return async function()
						{	if (arguments.length != 1)
							{	throw new Error('Invalid number of arguments to include()');
							}
							await php.write(REC_CALL_INCLUDE_ONCE, JSON.stringify(arguments[0]));
							return await php.read();
						};
						case 'require': return async function()
						{	if (arguments.length != 1)
							{	throw new Error('Invalid number of arguments to require()');
							}
							await php.write(REC_CALL_REQUIRE, JSON.stringify(arguments[0]));
							return await php.read();
						};
						case 'require_once': return async function()
						{	if (arguments.length != 1)
							{	throw new Error('Invalid number of arguments to require()');
							}
							await php.write(REC_CALL_REQUIRE_ONCE, JSON.stringify(arguments[0]));
							return await php.read();
						};
						default: return async function()
						{	await php.write(REC_CALL, arguments.length==0 ? func_name : func_name+' '+JSON.stringify([...arguments]));
							return await php.read();
						};
					}
				},
				set(php, prop_name, value)
				{	return false;
				}
			}
		);

		this.c = new Proxy
		(	this,
			{	get(php, class_name)
				{	if (typeof(class_name)!='string' || class_name.length==0 || class_name.length>128 || class_name.indexOf(' ')!=-1)
					{	throw new Error('Invalid class name');
					}
					return get_c(php, class_name);
				},
				set(php, prop_name, value)
				{	return false;
				}
			}
		);

		function get_c(php: PhpInterpreter, class_name: string): any
		{	return new Proxy
			(	function() {}, // if this is not a function, construct() and apply() will throw error
				{	get(_, prop_name) // get Class::CONST, Class::$var, or Ns\NsOrClass
					{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>128 || prop_name.indexOf(' ')!=-1)
						{	throw new Error('Invalid static property name');
						}
						let promise: Promise<any>|undefined;
						return new Proxy
						(	function() {},
							{	get(_, prop_name_2)
								{	let func;
									if (prop_name_2 == 'then')
									{	func = (y: any, n: any) => promise!.then(y, n);
									}
									else if (prop_name_2 == 'catch')
									{	func = (n: any) => promise!.catch(n);
									}
									else if (prop_name_2 == 'finally')
									{	func = (y: any) => promise!.finally(y);
									}
									else if (typeof(prop_name_2) == 'string')
									{	// Ns\NsOrClass
										let ns = get_c(php, class_name+'\\'+prop_name);
										return ns[prop_name_2];
									}
									else
									{	throw new Error(`Static class property "${prop_name}": value must be awaited`);
									}
									// Class::CONST or Class::$var
									if (!promise)
									{	if (prop_name.charAt(0) == '$')
										{	promise = php.write(REC_CLASSSTATIC_GET, class_name+' '+prop_name.slice(1)).then(() => php.read());
										}
										else
										{	promise = php.write(REC_CLASSSTATIC_CONST, class_name+' '+prop_name).then(() => php.read());
										}
									}
									return func;
								},
								set(_, prop_name_2, value)
								{	if (typeof(prop_name_2)!='string' || prop_name_2.length<2 || prop_name_2.length>129 || prop_name_2.indexOf(' ')!=-1 || prop_name_2.charAt(0)!='$')
									{	throw new Error('Invalid static property name');
									}
									let class_and_prop_name = class_name+'\\'+prop_name+' '+prop_name_2.slice(1); // cut '$'
									let job = php.write(REC_CLASSSTATIC_SET, value==null ? class_and_prop_name : class_and_prop_name+' '+JSON.stringify(value));
									assert(!php.ongoing); // write() must take the ongoing job
									php.ongoing = job;
									return true;
								},
								async apply(_, proxy, args)
								{	await php.write(REC_CLASSSTATIC_CALL, args.length==0 ? class_name+' '+prop_name : class_name+' '+prop_name+' '+JSON.stringify([...args]));
									return await php.read();
								},
								construct(_, args) // new Class
								{	return construct(php, class_name+'\\'+prop_name, args);
								}
							}
						);
					},
					set(_, prop_name, value) // set static class variable
					{	if (typeof(prop_name)!='string' || prop_name.length<2 || prop_name.length>129 || prop_name.indexOf(' ')!=-1 || prop_name.charAt(0)!='$')
						{	throw new Error('Invalid static property name');
						}
						let class_and_prop_name = class_name+' '+prop_name.slice(1); // cut '$'
						let job = php.write(REC_CLASSSTATIC_SET, value==null ? class_and_prop_name : class_and_prop_name+' '+JSON.stringify(value));
						assert(!php.ongoing); // write() must take the ongoing job
						php.ongoing = job;
						return true;
					},
					construct(_, args) // new Class
					{	return construct(php, class_name, args);
					}
				}
			);
		}

		async function construct(php: PhpInterpreter, class_name: string, args: IArguments)
		{	await php.write(REC_CONSTRUCT, args.length==0 ? class_name : class_name+' '+JSON.stringify([...args]));
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
						let job = php.write(REC_CLASS_SET, value==null ? h_inst+' '+prop_name : h_inst+' '+prop_name+' '+JSON.stringify(value));
						assert(!php.ongoing); // write() must take the ongoing job
						php.ongoing = job;
						return true;
					},
					deleteProperty(_, prop_name)
					{	if (typeof(prop_name)!='string' || prop_name.length==0 || prop_name.length>128 || prop_name.indexOf(' ')!=-1)
						{	return false;
						}
						if (prop_name == 'this')
						{	let job = php.write(REC_DESTRUCT, h_inst+'');
							assert(!php.ongoing); // write() must take the ongoing job
							php.ongoing = job;
							return true;
						}
						return false;
					}
				}
			);
		}
	}

	private async write(record_type: number, str: string)
	{	if (!this.commands_io)
		{	this.socket = Deno.listen({path: SOCKET_NAME, transport: 'unix'});
			await sleep(0);
			this.proc = Deno.run
			(	{	cmd: DEBUG_PHP_INIT ? [PHP_CLI_NAME, 'php-init.ts'] : [PHP_CLI_NAME, '-r', PHP_INIT.slice('<?php\n\n'.length)],
					stdin: 'piped',
					stdout: 'inherit',
					stderr: 'inherit'
				}
			);
			this.commands_io = await this.socket.accept();
		}
		else if (this.ongoing)
		{	let {ongoing} = this;
			this.ongoing = undefined;
			await ongoing;
		}
		str = '01230123'+str;
		let body = this.encoder.encode(str);
		let len = new DataView(body.buffer);
		len.setInt32(0, record_type);
		len.setInt32(4, body.length - 8);
		await Deno.writeAll(this.proc!.stdin!, body);
	}

	private async read(): Promise<any>
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

	async exit()
	{	let error;
		if (this.ongoing)
		{	try
			{	await this.ongoing;
			}
			catch (e)
			{	error = e;
			}
			this.ongoing = undefined;
		}
		this.proc?.stdin!.close();
		await this.proc?.status();
		this.proc?.close();
		this.commands_io?.close();
		this.socket?.close();
		this.proc = undefined;
		this.socket = undefined;
		this.commands_io = undefined;
		let yes = await exists(SOCKET_NAME);
		if (yes)
		{	await Deno.remove(SOCKET_NAME);
		}
		if (error)
		{	throw error;
		}
	}
}

var php_singleton = new PhpInterpreter;
export var g = php_singleton.g;
export var f = php_singleton.f;
export var c = php_singleton.c;
