import {debug_assert} from './debug_assert.ts';
import {PHP_BOOT, get_php_boot_filename} from './php-init.ts';
import {create_proxy} from './proxy_object.ts';
import {ReaderMux} from './reader_mux.ts';
import {fcgi, ResponseWithCookies, writeAll, copy} from './deps.ts';

const PHP_CLI_NAME_DEFAULT = 'php';
const DEBUG_PHP_BOOT = false;
const KEY_LEN = 32;
const READER_MUX_END_MARK_LEN = 32;
const BUFFER_LEN = 1024; // so small packets will not need allocation
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10_000;

debug_assert(BUFFER_LEN>=8 && BUFFER_LEN>=KEY_LEN && BUFFER_LEN>=READER_MUX_END_MARK_LEN);

const enum REC
{	DATA,
	CONST,
	GET,
	GET_THIS,
	SET,
	SET_INST,
	SET_PATH,
	SET_PATH_INST,
	UNSET,
	UNSET_PATH,
	CLASSSTATIC_GET,
	CLASSSTATIC_GET_THIS,
	CLASSSTATIC_SET,
	CLASSSTATIC_SET_INST,
	CLASSSTATIC_SET_PATH,
	CLASSSTATIC_SET_PATH_INST,
	CLASSSTATIC_UNSET,
	CONSTRUCT,
	DESTRUCT,
	CLASS_GET,
	CLASS_GET_THIS,
	CLASS_SET,
	CLASS_SET_INST,
	CLASS_SET_PATH,
	CLASS_SET_PATH_INST,
	CLASS_UNSET,
	CLASS_UNSET_PATH,
	CLASS_CALL,
	CLASS_CALL_PATH,
	CLASS_INVOKE,
	CLASS_ITERATE_BEGIN,
	CLASS_ITERATE,
	POP_FRAME,
	N_OBJECTS,
	END_STDOUT,
	CALL,
	CALL_THIS,
	CALL_EVAL,
	CALL_EVAL_THIS,
	CALL_ECHO,
	CALL_INCLUDE,
	CALL_INCLUDE_ONCE,
	CALL_REQUIRE,
	CALL_REQUIRE_ONCE,
}

const enum RES
{	ERROR = 1,
	GET_CLASS,
	CONSTRUCT,
	DESTRUCT,
	CLASS_GET,
	CLASS_SET,
	CLASS_CALL,
	CLASS_INVOKE,
	CLASS_GET_ITERATOR,
	CLASS_TO_STRING,
	CLASS_ISSET,
	CLASS_UNSET,
	CLASS_PROPS,
	CLASSSTATIC_CALL,
	CALL,
	JSON_ENCODE,
}

const enum RESTYPE
{	HAS_ITERATOR = 1,
	HAS_LENGTH = 2,
	HAS_SIZE = 4,
	IS_STRING = 8,
	IS_JSON = 16,
	IS_ERROR = 32,
}

const RE_BAD_CLASSNAME_FOR_EVAL = /[^\w\\]/;

const symbol_php_object = Symbol('php_object');

const encoder = new TextEncoder;
const decoder = new TextDecoder;

fcgi.onError(e => {console.error(e)});

async function get_random_key(buffer: Uint8Array): Promise<string>
{	let fh;
	try
	{	fh = await Deno.open('/dev/urandom', {read: true});
	}
	catch
	{	// assume: OS without /dev/urandom feature
		return Math.random()+'';
	}
	try
	{	let pos = 0;
		while (pos < buffer.length)
		{	let n_read = await fh.read(buffer.subarray(pos));
			if (n_read == null)
			{	throw new Error(`Failed to read from /dev/urandom`);
			}
			pos += n_read;
		}
	}
	finally
	{	fh.close();
	}
	return btoa(String.fromCharCode(...buffer));
}

function get_weak_random_bytes(buffer: Uint8Array)
{	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = Math.floor(Math.random()*256);
	}
	return buffer;
}

function get_class_features(symbol: any)
{	let features = 0;
	if (symbol.prototype)
	{	let desc = Object.getOwnPropertyDescriptors(symbol.prototype);
		if (desc.length)
		{	features |= RESTYPE.HAS_LENGTH;
		}
		if (desc.size) // accessing symbol.prototype.size directly throws error on Map
		{	features |= RESTYPE.HAS_SIZE;
		}
		if (typeof(symbol.prototype[Symbol.iterator])=='function' || typeof(symbol.prototype[Symbol.asyncIterator])=='function')
		{	features |= RESTYPE.HAS_ITERATOR;
		}
	}
	return features;
}

function get_inst_features(value: any)
{	let features = 0;
	if (value)
	{	if (typeof(value.length) == 'number')
		{	features |= RESTYPE.HAS_LENGTH;
		}
		if (typeof(value.size) == 'number')
		{	features |= RESTYPE.HAS_SIZE;
		}
		if (typeof(value[Symbol.iterator])=='function' || typeof(value[Symbol.asyncIterator])=='function')
		{	features |= RESTYPE.HAS_ITERATOR;
		}
	}
	return features;
}

function dispose_inst(inst: any)
{	if (typeof(inst.dispose) == 'function')
	{	try
		{	let v = inst.dispose();
			if (v instanceof Promise)
			{	v.catch
				(	e =>
					{	console.error(e);
					}
				);
			}
		}
		catch (e)
		{	console.error(e);
		}
	}
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

export interface PhpFpmSettings
{	listen: string;
	max_conns: number;

	/**	Connections to PHP-FPM service will be reused for this number of milliseconds (deno script may not exit while there're idle connections - call `php.close_idle()` to close them).
	 **/
	keep_alive_timeout: number;

	keep_alive_max: number;
	params: Map<string, string>;
	request: string|Request|URL;
	request_init?: RequestInit & {bodyIter?: AsyncIterable<Uint8Array>};

	/**	Callback that will be called as soon as PHP-FPM response is ready - usually after first echo from the remote PHP script, and maybe after a few more echoes, or at the end of the script (when `g.exit()` called).
		The callback receives a `ResponseWithCookies` object that extends built-in `Response`.
		The response contains headers and body reader, that will read everything echoed from the script.
		In this callback you need to await till you finished working with the response object, as it will be destroyed after this callback ends.
		The returned `ResponseWithCookies` object extends built-in `Response` (that `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
		Also `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.
	 **/
	onresponse?: (response: ResponseWithCookies) => Promise<unknown>;
}

/**	Settings that affect `PhpInterpreter` behavior.
 **/
export class PhpSettings
{	/**	Command that will be executed to spawn a PHP-CLI process. This setting is ignored if `php_fpm.listen` is set.
	 **/
	public php_cli_name = PHP_CLI_NAME_DEFAULT;

	public php_fpm: PhpFpmSettings =
	{	listen: '',
		keep_alive_timeout: DEFAULT_KEEP_ALIVE_TIMEOUT,
		keep_alive_max: Number.MAX_SAFE_INTEGER,
		params: new Map,
		request: 'http://localhost/',
		max_conns: 128,
	};

	public unix_socket_name = '';
	public stdout: 'inherit'|'piped'|'null'|number = 'inherit';

	/**	If set to existing PHP file, will chdir() to this file's directory, and execute this file before doing first requested operation (including `g.exit()`).
		Then this setting will be reset to empty string, so next call to `g.exit()` will not rerun the file.
		If you want to rerun, set `init_php_file` again.
	 **/
	public init_php_file = '';

	public onsymbol: (name: string) => any = () => {};

	constructor(init_settings?: PhpSettingsInit)
	{	this.php_cli_name = init_settings?.php_cli_name ?? this.php_cli_name;
		this.php_fpm.listen = init_settings?.php_fpm?.listen ?? this.php_fpm.listen;
		this.php_fpm.keep_alive_timeout = init_settings?.php_fpm?.keep_alive_timeout ?? this.php_fpm.keep_alive_timeout;
		this.php_fpm.keep_alive_max = init_settings?.php_fpm?.keep_alive_max ?? this.php_fpm.keep_alive_max;
		this.php_fpm.params = init_settings?.php_fpm?.params ?? this.php_fpm.params;
		this.php_fpm.request = init_settings?.php_fpm?.request ?? this.php_fpm.request;
		this.php_fpm.max_conns = init_settings?.php_fpm?.max_conns ?? this.php_fpm.max_conns;
		this.unix_socket_name = init_settings?.unix_socket_name ?? this.unix_socket_name;
		this.stdout = init_settings?.stdout ?? this.stdout;
		this.init_php_file = init_settings?.init_php_file ?? this.init_php_file;
		this.onsymbol = init_settings?.onsymbol ?? this.onsymbol;
	}
}

type PhpSettingsInit = Partial<Omit<PhpSettings, 'php_fpm'>> & {php_fpm?: Partial<PhpFpmSettings>};

/**	Each instance of this class represents a PHP interpreter. It can be spawned CLI process that runs in background, or it can be a FastCGI request to a PHP-FPM service.
	The interpreter will be actually spawned on first remote call.
	Calling `this.g.exit()` terminates the interpreter (or a FastCGI connection).
	Further remote calls will respawn another interpreter.
	It's alright to call `this.g.exit()` several times.
 **/
export class PhpInterpreter
{	private php_cli_proc: Deno.Process|undefined;
	private php_fpm_response: Promise<ResponseWithCookies>|undefined;
	private listener: Deno.Listener|undefined;
	private commands_io: Deno.Conn|undefined;
	private buffer = new Uint8Array;
	private is_inited = false;
	private using_unix_socket = '';
	private ongoing: Promise<unknown>[] = [];
	private ongoing_level = 0;
	private ongoing_stderr: Promise<unknown> = Promise.resolve();
	private stdout_mux: ReaderMux|undefined;
	private last_inst_id = -1;
	private stack_frames: number[] = [];
	private deno_insts: Map<number, any> = new Map; // php has handles to these objects
	private deno_inst_id_enum = 2; // later will do: deno_insts.set(0, this); deno_insts.set(1, globalThis);

	/**	For accessing remote global PHP objects, except classes (functions, variables, constants).
	 **/
	public g: any;

	/**	For accessing remote PHP classes.
	 **/
	public c: any;

	/**	Modify settings before spawning interpreter or connecting to PHP-FPM service.
	 **/
	public settings: PhpSettings;

	/**	You can have as many PHP interpreter instances as you want. Don't forget to call `this.g.exit()` to destroy the background interpreter.
	 **/
	constructor(init_settings?: PhpSettingsInit)
	{	this.settings = new PhpSettings(init_settings);

		this.g = get_global(this, false);
		this.c = get_global(this, true);

		this.deno_insts.set(0, this);
		this.deno_insts.set(1, globalThis);

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
										return function(prop_name)
										{	let record_type = REC.CONST;
											let path_str = prop_name;
											if (prop_name.charAt(0) == '$')
											{	path_str = path_str.slice(1); // cut '$'
												record_type = REC.GET;
											}
											return php.write_read(record_type, path_str);
										};
									}
									else if (path[0].charAt(0) != '$')
									{	// case: A\B\C
										let path_str = path.join('\\');
										return function(prop_name)
										{	return php.write_read(REC.CONST, path_str+'\\'+prop_name);
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
												return await php.write_read(REC.GET, path_str+' '+JSON.stringify(path_2));
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												return construct(php, await php.write_read(REC.GET_THIS, path_str));
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
										return function(prop_name)
										{	let record_type = REC.CONST;
											let path_str_2 = path_str;
											if (prop_name.charAt(0) != '$')
											{	path_str_2 += '::'+prop_name;
											}
											else
											{	record_type = REC.CLASSSTATIC_GET;
												if (prop_name.indexOf(' ') != -1)
												{	throw new Error(`Variable name must not contain spaces: ${path_str_2}::${prop_name}`);
												}
												path_str_2 += ' '+prop_name.slice(1); // cut '$'
											}
											return php.write_read(record_type, path_str_2);
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
												return await php.write_read(REC.CLASSSTATIC_GET, path_str+' '+JSON.stringify(path_2));
											}
											else
											{	if (path_2.length >= 2)
												{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
												}
												return construct(php, await php.write_read(REC.CLASSSTATIC_GET_THIS, path_str));
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
									let path_str_2 = '[';
									if (path.length > 1)
									{	path_str_2 = JSON.stringify(path.slice(1)).slice(0, -1)+',';
									}
									return function(prop_name, value)
									{	if (value == null)
										{	php.write_read(REC.SET_PATH, path_str+' ['+path_str_2+JSON.stringify(prop_name)+'],null]');
										}
										else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
										{	php.write_read(REC.SET_PATH_INST, path_str+' '+php.new_deno_inst(value)+' '+path_str_2+JSON.stringify(prop_name)+']');
										}
										else
										{	php.write_read(REC.SET_PATH, path_str+' ['+path_str_2+JSON.stringify(prop_name)+'],'+php.json_stringify_serialize_insts(value)+']');
										}
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
											if (value == null)
											{	php.write_read(REC.CLASSSTATIC_SET, path_str_2);
											}
											else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
											{	php.write_read(REC.CLASSSTATIC_SET_INST, path_str_2+' '+php.new_deno_inst(value));
											}
											else
											{	php.write_read(REC.CLASSSTATIC_SET, path_str_2+' '+php.json_stringify_serialize_insts(value));
											}
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
										{	if (value == null)
											{	php.write_read(REC.CLASSSTATIC_SET_PATH, path_str+JSON.stringify(prop_name)+'],null]');
											}
											else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
											{	php.write_read(REC.CLASSSTATIC_SET_PATH_INST, path_str+JSON.stringify(prop_name)+'],'+php.new_deno_inst(value)+']');
											}
											else
											{	php.write_read(REC.CLASSSTATIC_SET_PATH, path_str+JSON.stringify(prop_name)+'],'+php.json_stringify_serialize_insts(value)+']');
											}
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
									{	php.write_read(REC.UNSET_PATH, path_str+prop_name+path_str_2);
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
										php.write_read(REC.CLASSSTATIC_UNSET, path_str+JSON.stringify(path_2));
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
												return function()
												{	return php.exit();
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
															{	await php.do_write(REC.CALL_EVAL, path_str);
																return await php.do_read();
															}
														}
													);
													Object.defineProperty
													(	promise,
														'this',
														{	async get()
															{	is_this = true;
																return construct(php, await php.write_read(REC.CALL_EVAL_THIS, path_str));
															}
														}
													);
													return promise;
												};
											case 'echo':
												return function(args)
												{	return php.write_read(REC.CALL_ECHO, php.json_stringify_serialize_insts([...args]));
												};
											case 'include':
												return function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include()');
													}
													return php.write_read(REC.CALL_INCLUDE, JSON.stringify(args[0]));
												};
											case 'include_once':
												return function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to include_once()');
													}
													return php.write_read(REC.CALL_INCLUDE_ONCE, JSON.stringify(args[0]));
												};
											case 'require':
												return function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require()');
													}
													return php.write_read(REC.CALL_REQUIRE, JSON.stringify(args[0]));
												};
											case 'require_once':
												return function(args)
												{	if (args.length != 1)
													{	throw new Error('Invalid number of arguments to require_once()');
													}
													return php.write_read(REC.CALL_REQUIRE_ONCE, JSON.stringify(args[0]));
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
									{	path_str_2 += ' '+php.json_stringify_serialize_insts([...args]);
									}
									let is_this = false;
									let promise = php.schedule
									(	async () =>
										{	if (!is_this)
											{	await php.do_write(REC.CALL, path_str_2);
												return await php.do_read();
											}
										}
									);
									Object.defineProperty
									(	promise,
										'this',
										{	async get()
											{	is_this = true;
												return construct(php, await php.write_read(REC.CALL_THIS, path_str_2));
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
								{	return construct(php, await php.write_read(REC.CONSTRUCT, args.length==0 ? class_name : class_name+' '+php.json_stringify_serialize_insts([...args])), class_name);
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
						if (value == null)
						{	php.write_read(REC.SET, prop_name);
						}
						else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
						{	php.write_read(REC.SET_INST, prop_name+' '+php.new_deno_inst(value));
						}
						else
						{	php.write_read(REC.SET, prop_name+' '+php.json_stringify_serialize_insts(value));
						}
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
						php.write_read(REC.UNSET, prop_name);
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
			let php_inst_id = Number(result);
			php.last_inst_id = php_inst_id;
			return create_proxy
			(	[],
				class_name,

				// get
				path =>
				{	if (path.length == 0)
					{	let path_str = php_inst_id+' ';
						return function(prop_name)
						{	if (prop_name.indexOf(' ') != -1)
							{	throw new Error(`Property name must not contain spaces: $${prop_name}`);
							}
							return php.write_read(REC.CLASS_GET, path_str+prop_name);
						};
					}
					else
					{	let path_str = php_inst_id+' '+path[0];
						let path_2 = path.slice(1).concat(['']);
						return async function(prop_name)
						{	if (prop_name != 'this')
							{	path_2[path_2.length-1] = prop_name;
								return await php.write_read(REC.CLASS_GET, path_str+' '+JSON.stringify(path_2));
							}
							else
							{	if (path_2.length >= 2)
								{	path_str += ' '+JSON.stringify(path_2.slice(0, -1));
								}
								return construct(php, await php.write_read(REC.CLASS_GET_THIS, path_str));
							}
						};
					}
				},

				// set
				path =>
				{	if (path.length == 0)
					{	let path_str = php_inst_id+' ';
						return function(prop_name, value)
						{	if (prop_name.indexOf(' ') != -1)
							{	throw new Error(`Property name must not contain spaces: ${prop_name}`);
							}
							if (value == null)
							{	php.write_read(REC.CLASS_SET, path_str+prop_name);
							}
							else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
							{	php.write_read(REC.CLASS_SET_INST, path_str+prop_name+' '+php.new_deno_inst(value));
							}
							else
							{	php.write_read(REC.CLASS_SET, path_str+prop_name+' '+php.json_stringify_serialize_insts(value));
							}
							return true;
						};
					}
					else
					{	let path_str = php_inst_id+' '+path[0]+' [';
						if (path.length > 1)
						{	path_str += JSON.stringify(path.slice(1)).slice(0, -1)+',';
						}
						else
						{	path_str += '[';
						}
						return function(prop_name, value)
						{	if (value == null)
							{	php.write_read(REC.CLASS_SET_PATH, path_str+JSON.stringify(prop_name)+'],null]');
							}
							else if (typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
							{	php.write_read(REC.CLASS_SET_PATH_INST, path_str+JSON.stringify(prop_name)+'],'+php.new_deno_inst(value)+']');
							}
							else
							{	php.write_read(REC.CLASS_SET_PATH, path_str+JSON.stringify(prop_name)+'],'+php.json_stringify_serialize_insts(value)+']');
							}
							return true;
						};
					}
				},

				// deleteProperty
				path =>
				{	if (path.length == 0)
					{	let path_str = php_inst_id+'';
						return function(prop_name)
						{	if (prop_name == 'this')
							{	php.write(REC.DESTRUCT, path_str);
								return true;
							}
							php.write_read(REC.CLASS_UNSET, path_str+' '+prop_name);
							return true;
						};
					}
					else
					{	let path_str = php_inst_id+' ';
						let path_str_2 = ' '+JSON.stringify(path);
						return function(prop_name)
						{	php.write_read(REC.CLASS_UNSET_PATH, path_str+prop_name+path_str_2);
							return true;
						};
					}
				},

				// apply
				path =>
				{	if (path.length == 0)
					{	return function(args)
						{	return php.write_read(REC.CLASS_INVOKE, args.length==0 ? php_inst_id+'' : php_inst_id+' '+php.json_stringify_serialize_insts([...args]));
						};
					}
					if (path.length == 1)
					{	if (path[0] == 'toJSON')
						{	return function()
							{	return {PHP_WORLD_INST_ID: php_inst_id};
							};
						}
						else
						{	let path_str = php_inst_id+' '+path[0];
							return function(args)
							{	return php.write_read(REC.CLASS_CALL, args.length==0 ? path_str : path_str+' '+php.json_stringify_serialize_insts([...args]));
							};
						}
					}
					else
					{	if (path[path.length-1].indexOf(' ') != -1)
						{	throw new Error(`Function name must not contain spaces: ${path[path.length-1]}`);
						}
						let path_str = php_inst_id+' '+path[path.length-1]+' ['+JSON.stringify(path.slice(0, -1))+',';
						return function(args)
						{	return php.write_read(REC.CLASS_CALL_PATH, path_str+php.json_stringify_serialize_insts([...args])+']');
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
				{	let path_str = php_inst_id+'';
					return async function*()
					{	let [value, done] = await php.write_read(REC.CLASS_ITERATE_BEGIN, path_str);
						while (true)
						{	if (done)
							{	return;
							}
							yield value;
							[value, done] = await php.write_read(REC.CLASS_ITERATE, path_str);
						}
					};
				},

				symbol_php_object
			);
		}
	}

	private async do_init()
	{	// 1. Set is_inited flag, to avoid entering this function recursively
		debug_assert(!this.is_inited);
		debug_assert(!this.php_cli_proc && !this.php_fpm_response && !this.stdout_mux && !this.commands_io);
		this.is_inited = true;
		if (this.buffer.length == 0)
		{	this.buffer = new Uint8Array(BUFFER_LEN);
		}
		// 2. Open a listener, and start listening
		let php_socket;
		if (this.settings.unix_socket_name)
		{	this.using_unix_socket = this.settings.unix_socket_name;
			this.listener = Deno.listen({transport: 'unix', path: this.using_unix_socket});
			php_socket = 'unix://'+this.using_unix_socket;
		}
		else
		{	this.using_unix_socket = '';
			this.listener = Deno.listen({transport: 'tcp', hostname: '127.0.0.1', port: 0});
			php_socket = 'tcp://127.0.0.1:'+(this.listener.addr as Deno.NetAddr).port;
		}
		// 3. HELO (generate random key)
		let key = await get_random_key(this.buffer.subarray(0, KEY_LEN));
		let end_mark = get_weak_random_bytes(this.buffer.subarray(0, READER_MUX_END_MARK_LEN));
		let {init_php_file} = this.settings;
		this.settings.init_php_file = ''; // so second call to `exit()` will not reexecute the init script. if reexecution is needed, reassign `this.settings.init_php_file`
		let rec_helo = key+' '+btoa(String.fromCharCode(...end_mark))+' '+btoa(php_socket)+' '+btoa(init_php_file);
		let php_boot_file = '';
		// 4. Run the PHP interpreter or connect to PHP-FPM service
		if (!this.settings.php_fpm.listen)
		{	// Run the PHP interpreter
			let cmd = DEBUG_PHP_BOOT ? [this.settings.php_cli_name, '-f', await get_php_boot_filename(true)] : [this.settings.php_cli_name, '-r', PHP_BOOT.slice('<?php\n\n'.length)];
			if (Deno.args.length)
			{	cmd.splice(cmd.length, 0, '--', ...Deno.args);
			}
			this.php_cli_proc = Deno.run({cmd, stdin: 'piped', stdout: this.settings.stdout, stderr: 'inherit'});
			// Send the HELO packet with opened listener address and the key
			await writeAll(this.php_cli_proc.stdin!, encoder.encode(rec_helo));
			this.php_cli_proc.stdin!.close();
			// Mux stdout
			if (this.settings.stdout == 'piped')
			{	this.stdout_mux = new ReaderMux(Promise.resolve(this.php_cli_proc.stdout), end_mark.slice());
			}
		}
		else
		{	// Connect to PHP-FPM service
			// First create php file with init script
			php_boot_file = await get_php_boot_filename(DEBUG_PHP_BOOT);
			// Prepare params
			let {params} = this.settings.php_fpm;
			if (params.has('DENO_WORLD_HELO'))
			{	// looks like object shared between requests
				let params_clone = new Map;
				for (let [k, v] of params)
				{	params_clone.set(k, v);
				}
				params = params_clone;
			}
			params.set('DENO_WORLD_HELO', rec_helo);
			params.set('SCRIPT_FILENAME', php_boot_file);
			// max_conns
			fcgi.options({maxConns: this.settings.php_fpm.max_conns});
			// FCGI fetch
			if (!fcgi.canFetch())
			{	await fcgi.waitCanFetch();
			}
			this.php_fpm_response = fcgi.fetch
			(	{	addr: this.settings.php_fpm.listen,
					params,
					timeout: Number.MAX_SAFE_INTEGER,
					keepAliveTimeout: this.settings.php_fpm.keep_alive_timeout,
					keepAliveMax: this.settings.php_fpm.keep_alive_max,
					onLogError: msg =>
					{	this.ongoing_stderr = this.ongoing_stderr.then(() => writeAll(Deno.stderr, encoder.encode(msg+'\n')));
					}
				},
				this.settings.php_fpm.request,
				this.settings.php_fpm.request_init
			);
			// Mux stdout
			if (this.settings.stdout != 'inherit')
			{	this.stdout_mux = new ReaderMux(this.php_fpm_response.then(r => r.body), end_mark.slice());
			}
			// onresponse
			if (this.settings.php_fpm.onresponse)
			{	let {onresponse} = this.settings.php_fpm;
				this.php_fpm_response = this.php_fpm_response.then
				(	async r =>
					{	try
						{	await onresponse(r);
						}
						catch (e)
						{	console.error(e);
						}
						return r;
					}
				);
			}
		}
		// 5. Accept connection from the interpreter. Identify it by the key.
		while (true)
		{	let accept = this.listener.accept();
			if (!this.php_fpm_response)
			{	this.commands_io = await accept;
			}
			else
			{	let result = await Promise.race([accept, this.php_fpm_response]);
				if (result instanceof ResponseWithCookies)
				{	accept.then(s => s.close());
					throw new Error(`Failed to execute PHP-FPM script "${php_boot_file}" through socket "${this.settings.php_fpm.listen}": status ${result.status}, ${await result.text()}`);
				}
				this.commands_io = result;
			}
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
		// 6. init_php_file
		if (init_php_file)
		{	// i executed init_php_file that produced result (and maybe deno calls)
			let result = await this.do_read();
			debug_assert(result == null);
		}
	}

	private async do_write(record_type: number, str: string)
	{	if (!this.is_inited)
		{	await this.do_init();
		}
		let body = str.length<=this.buffer.length ? this.buffer : new Uint8Array(str.length+128);
		let offset = 8;
		while (true)
		{	let {read, written} = encoder.encodeInto(str, body.subarray(offset));
			offset += written;
			if (read == str.length)
			{	break;
			}
			str = str.slice(read);
			let new_body = new Uint8Array(offset + str.length*2);
			new_body.set(body);
			body = new_body;
		}
		let header = new DataView(body.buffer);
		header.setInt32(0, record_type);
		header.setInt32(4, offset-8);
		let padding = (8 - offset%8) % 8;
		if (offset+padding <= body.length)
		{	body = body.subarray(0, offset+padding);
		}
		else
		{	let new_body = new Uint8Array(offset+padding);
			new_body.set(body);
			body = new_body;
		}
		if (this.stdout_mux && !this.stdout_mux.is_reading)
		{	let {stdout} = this.settings;
			let writer: Deno.Writer;
			if (typeof(stdout) == 'number')
			{	let rid = stdout;
				writer =
				{	async write(data)
					{	return await Deno.write(rid, data);
					}
				};
			}
			else if (stdout == 'null')
			{	writer =
				{	async write(data)
					{	return data.length;
					}
				};
			}
			else
			{	writer = Deno.stdout;
			}
			await this.stdout_mux.set_writer(writer);
		}
		await writeAll(this.commands_io!, body);
	}

	private async do_read(): Promise<any>
	{	while (true)
		{	let buffer = this.buffer.subarray(0, 8); // records are aligned to 8-byte boundaries, and padding is added as needed
			let pos = 0;
			while (pos < 8)
			{	let n_read = await this.commands_io!.read(buffer);
				if (n_read == null)
				{	this.exit_status_to_exception(await this.do_exit(true));
				}
				pos += n_read;
			}
			let [len, first_word] = new Int32Array(buffer.buffer);
			if (len == 0)
			{	return null; // null
			}
			let is_result = true;
			if (len < 0)
			{	if (len == -1)
				{	return; // undefined
				}
				is_result = false;
				len = -len;
			}
			let padding = (8 - (len + 4)%8) % 8;
			len += padding;
			buffer = len<=this.buffer.length ? this.buffer.subarray(0, len) : new Uint8Array(len);
			pos = 4; // first_word already read
			while (pos < len)
			{	let n_read = await this.commands_io!.read(buffer.subarray(pos));
				if (n_read == null)
				{	this.exit_status_to_exception(await this.do_exit(true));
				}
				pos += n_read;
			}
			if (is_result)
			{	(new Int32Array(buffer.buffer))[0] = first_word;
				return this.json_parse_unserialize_insts(decoder.decode(buffer.subarray(padding)));
			}
			let view = new DataView(buffer.buffer);
			let type = first_word;
			let deno_inst_id = view.getUint32(4);
			let result = buffer.length<=8+padding ? '' : decoder.decode(buffer.subarray(8+padding));
			if (type == RES.ERROR)
			{	let [file, line, message, trace] = JSON.parse(result);
				throw new InterpreterError(message, file, Number(line), trace);
			}
			let data: any;
			let result_type = RESTYPE.IS_JSON;
			let g: any = globalThis;
			try
			{	this.ongoing_level++;
				switch (type)
				{	case RES.GET_CLASS:
					{	let class_name = result;
						let symbol = class_name in g ? g[class_name] : await this.settings.onsymbol(class_name);
						data = !symbol ? RESTYPE.IS_ERROR : get_class_features(symbol);
						break;
					}
					case RES.CONSTRUCT:
					{	let [class_name, args] = this.json_parse_unserialize_insts(result);
						let symbol = class_name in g ? g[class_name] : await this.settings.onsymbol(class_name);
						let deno_inst = new symbol(...args); // can throw error
						data = this.new_deno_inst(deno_inst);
						break;
					}
					case RES.DESTRUCT:
					{	dispose_inst(this.deno_insts.get(deno_inst_id));
						this.deno_insts.delete(deno_inst_id);
						continue;
					}
					case RES.CLASS_GET:
					{	let name = result;
						let deno_inst = this.deno_insts.get(deno_inst_id);
						data = await deno_inst[name]; // can throw error
						break;
					}
					case RES.CLASS_SET:
					{	let [name, value] = this.json_parse_unserialize_insts(result);
						let deno_inst = this.deno_insts.get(deno_inst_id);
						deno_inst[name] = value; // can throw error
						data = null;
						break;
					}
					case RES.CLASS_CALL:
					{	let [name, args] = this.json_parse_unserialize_insts(result);
						let deno_inst = this.deno_insts.get(deno_inst_id);
						data = await deno_inst[name](...args); // can throw error
						break;
					}
					case RES.CLASS_INVOKE:
					{	let args = this.json_parse_unserialize_insts(result);
						let deno_inst = this.deno_insts.get(deno_inst_id);
						data = await deno_inst(...args); // can throw error
						break;
					}
					case RES.CLASS_GET_ITERATOR:
					{	let deno_inst = this.deno_insts.get(deno_inst_id);
						data = deno_inst[Symbol.asyncIterator] ? deno_inst[Symbol.asyncIterator]() : deno_inst[Symbol.iterator] ? deno_inst[Symbol.iterator]() : Object.entries(deno_inst)[Symbol.iterator](); // can throw error
						break;
					}
					case RES.CLASS_TO_STRING:
					{	let deno_inst = this.deno_insts.get(deno_inst_id);
						data = deno_inst+''; // can throw error
						break;
					}
					case RES.CLASS_ISSET:
					{	let name = result;
						let deno_inst = this.deno_insts.get(deno_inst_id);
						data = deno_inst[name] != null; // can throw error
						break;
					}
					case RES.CLASS_UNSET:
					{	let name = result;
						let deno_inst = this.deno_insts.get(deno_inst_id);
						delete deno_inst[name]; // can throw error
						break;
					}
					case RES.CLASS_PROPS:
					{	let deno_inst = this.deno_insts.get(deno_inst_id);
						let props = [];
						for (let prop in deno_inst)
						{	props[props.length] = prop;
						}
						data = JSON.stringify(props);
						break;
					}
					case RES.CLASSSTATIC_CALL:
					{	let [class_name, name, args] = this.json_parse_unserialize_insts(result);
						let symbol = class_name in g ? g[class_name] : await this.settings.onsymbol(class_name);
						data = await symbol[name](...args); // can throw error
						break;
					}
					case RES.CALL:
					{	let [name, args] = this.json_parse_unserialize_insts(result);
						let symbol = name in g ? g[name] : await this.settings.onsymbol(name);
						data = await symbol(...args); // can throw error
						break;
					}
					case RES.JSON_ENCODE:
					{	let deno_inst = this.deno_insts.get(deno_inst_id);
						data = JSON.stringify(deno_inst); // can throw error
						break;
					}
					default:
						debug_assert(false);
				}
				if (data!=null && (typeof(data)=='object' || typeof(data)=='function'))
				{	result_type = get_inst_features(data);
					data = this.new_deno_inst(data);
				}
			}
			catch (e)
			{	result_type = RESTYPE.IS_ERROR;
				data = e.message;
			}
			finally
			{	this.ongoing_level--;
				if (this.ongoing.length > this.ongoing_level+1)
				{	this.ongoing.length = this.ongoing_level+1;
				}
			}
			if (result_type == RESTYPE.IS_JSON)
			{	if (typeof(data) == 'string')
				{	result_type = RESTYPE.IS_STRING;
				}
				else
				{	data = JSON.stringify(data);
				}
			}
			await this.do_write(REC.DATA, result_type+' '+data);
		}
	}

	private new_deno_inst(data: any)
	{	let deno_inst_id = this.deno_inst_id_enum++;
		this.deno_inst_id_enum &= 0x7FFF_FFFF;
		this.deno_insts.set(deno_inst_id, data);
		return deno_inst_id;
	}

	private json_parse_unserialize_insts(json: string)
	{	return JSON.parse
		(	json,
			(key, value) => typeof(value)=='object' && value?.DENO_WORLD_INST_ID>=0 ? this.deno_insts.get(value.DENO_WORLD_INST_ID) : value
		);
	}

	private json_stringify_serialize_insts(value: any)
	{	return JSON.stringify
		(	value,
			(key, value) =>
			{	if (value!=null && typeof(value)=='object' && value.constructor!=Object && value.constructor!=Array || typeof(value)=='function' && value[symbol_php_object]==null)
				{	return {DENO_WORLD_INST_ID: this.new_deno_inst(value)};
				}
				else
				{	return value;
				}
			}
		);
	}

	private async do_exit(is_eof=false): Promise<Deno.ProcessStatus>
	{	if (!this.is_inited && this.settings.init_php_file)
		{	await this.do_init();
		}
		try
		{	await this.do_drop_stdout_reader(is_eof, true);
		}
		catch (e)
		{	console.error(e);
		}
		try
		{	this.commands_io?.close();
		}
		catch (e)
		{	console.error(e);
		}
		if (this.stdout_mux)
		{	await this.stdout_mux.set_none();
		}
		if (this.php_fpm_response)
		{	try
			{	let response = await this.php_fpm_response;
				if (response.body)
				{	try
					{	await copy(response.body, {async write(p: Uint8Array) {return p.length}}); // read and discard
					}
					catch
					{	// ok, maybe onresponse already read the body
					}
				}
			}
			catch (e)
			{	console.error(e);
			}
			this.php_fpm_response = undefined;
		}
		if (this.stdout_mux)
		{	try
			{	this.php_cli_proc?.stdout!.close();
			}
			catch (e)
			{	console.error(e);
			}
			this.stdout_mux = undefined;
		}
		let status;
		if (this.php_cli_proc)
		{	try
			{	status = await this.php_cli_proc.status();
				this.php_cli_proc?.close();
			}
			catch (e)
			{	console.error(e);
				status = {success: false, code: -1} as Deno.ProcessStatus;
			}
		}
		else
		{	status = {success: true, code: 0} as Deno.ProcessStatus;
		}
		try
		{	this.listener?.close();
		}
		catch (e)
		{	console.error(e);
		}
		if (this.using_unix_socket)
		{	try
			{	await Deno.remove(this.using_unix_socket);
			}
			catch (e)
			{	if (e.name != 'NotFound')
				{	console.error(e);
				}
			}
		}
		debug_assert(this.ongoing.length <= 1);
		this.ongoing.length = 0;
		await this.ongoing_stderr;
		this.ongoing_stderr = Promise.resolve();
		this.php_cli_proc = undefined;
		this.listener = undefined;
		this.commands_io = undefined;
		this.is_inited = false;
		this.last_inst_id = -1;
		this.stack_frames.length = 0;
		for (let v of this.deno_insts.values())
		{	dispose_inst(v);
		}
		this.deno_insts.clear();
		this.deno_insts.set(0, this);
		this.deno_insts.set(1, globalThis);
		this.deno_inst_id_enum = 2;
		return status;
	}

	private exit_status_to_exception(status: {code: number} | undefined): never
	{	let code = status?.code ?? -1;
		let message = code==-1 ? 'PHP interpreter died' : code!=0 ? `PHP interpreter died with error code ${code}` : 'PHP interpreter exited';
		throw new InterpreterExitError(message, code);
	}

	private async do_push_frame()
	{	if (!this.is_inited)
		{	await this.do_init();
		}
		this.stack_frames.push(this.last_inst_id);
	}

	private async do_pop_frame()
	{	let last_inst_id = this.stack_frames.pop();
		if (last_inst_id == undefined)
		{	throw new Error('No frames to pop');
		}
		await this.do_write(REC.POP_FRAME, last_inst_id+'');
		this.last_inst_id = last_inst_id;
	}

	private async do_n_objects()
	{	await this.do_write(REC.N_OBJECTS, '');
		return await this.do_read();
	}

	private async do_get_stdout_reader(): Promise<Deno.Reader>
	{	if (!this.is_inited)
		{	await this.do_init();
		}
		if (!this.stdout_mux)
		{	throw new Error("Set settings.stdout to 'piped' to be able to redirect stdout");
		}
		if (this.stdout_mux.is_reading)
		{	await this.do_write(REC.END_STDOUT, '');
		}
		return await this.stdout_mux.get_reader();
	}

	private async do_drop_stdout_reader(is_eof=false, no_set_none=false)
	{	if (this.stdout_mux)
		{	if (this.stdout_mux.is_reading && !is_eof)
			{	await this.do_write(REC.END_STDOUT, '');
			}
			if (!no_set_none)
			{	await this.stdout_mux.set_none();
			}
		}
	}

	private schedule<T>(callback: () => Promise<T>): Promise<T>
	{	let {ongoing_level} = this;
		let ongoing = this.ongoing[ongoing_level];
		let promise = !ongoing ? callback() : ongoing.then(callback);
		this.ongoing[ongoing_level] = promise;
		queueMicrotask
		(	() =>
			{	let ongoing = this.ongoing[ongoing_level];
				if (ongoing)
				{	this.ongoing[ongoing_level] = ongoing.catch(() => {});
				}
			}
		);
		return promise;
	}

	/**	Each remote function call or a variable fetch queues operation. All the operations will be executed in sequence.
		This function returns promise that resolves when all current operations completed.
	 **/
	ready(): Promise<unknown>
	{	return this.ongoing[this.ongoing_level];
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

	/**	 All objects allocated after this call, can be freed at once.
	 **/
	push_frame()
	{	this.schedule(() => this.do_push_frame());
	}

	/**	Free at once all the objects allocated after last `php.push_frame()` call.
	 **/
	pop_frame()
	{	this.schedule(() => this.do_pop_frame());
	}

	/**	Number of allocated handles to remote PHP objects, that must be explicitly freed when not in use anymore.
	 **/
	n_objects()
	{	return this.schedule(() => this.do_n_objects());
	}

	/**	Number of Deno objects, that PHP-side currently holds.
		Initially there're 2: $php and $globalThis ($window == $globalThis).
		As you request Deno objects, this number will grow, and once you free references, this number will be decreased.

		import {g, php} from 'https://deno.land/x/php_world/mod.ts';

		console.log(await php.n_deno_objects()); // prints 2
		await g.eval
		(	`	global $window, $var;
				$var = $window->Deno;
			`
		);
		console.log(await php.n_deno_objects()); // prints 3
		await g.eval
		(	`	global $window, $var2;
				$var2 = new DenoWorld\\Map;
			`
		);
		console.log(await php.n_deno_objects()); // prints 4
		await g.eval
		(	`	global $var, $var2;
				$var = null;
				$var2 = null;
			`
		);
		console.log(await php.n_deno_objects()); // prints 2
		await g.eval
		(	`	global $php, $window, $globalThis;
				$php = null;
				$window = null;
				$globalThis = null;
			`
		);
		console.log(await php.n_deno_objects()); // prints 0

		await g.exit();

	 **/
	n_deno_objects()
	{	return this.schedule(() => Promise.resolve(this.deno_insts.size));
	}

	get_stdout_reader()
	{	return this.schedule(() => this.do_get_stdout_reader());
	}

	drop_stdout_reader()
	{	return this.schedule(() => this.do_drop_stdout_reader());
	}

	/**	If PHP-FPM interface was used, and `settings.php_fpm.keep_alive_timeout` was > 0, connections to PHP-FPM service will be reused.
		This can hold deno script from exiting the program. Call `php.close_idle()` to close all the idle connections.
	 **/
	close_idle()
	{	fcgi.closeIdle();
	}
}
