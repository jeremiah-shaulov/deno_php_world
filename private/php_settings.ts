import {ResponseWithCookies} from './deps.ts';

const PHP_CLI_NAME_DEFAULT = 'php';
const DEFAULT_CONNECT_TIMEOUT = 4_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10_000;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface PhpFpmSettings
{	listen: string;
	max_conns: number;

	connect_timeout: number;

	/**	Connections to PHP-FPM service will be reused for this number of milliseconds (deno script may not exit while there're idle connections - call `php.close_idle()` to close them).
	 **/
	keep_alive_timeout: number;

	keep_alive_max: number;
	params: Map<string, string>;
	request: string|Request|URL;
	request_init?: RequestInit;

	/**	Callback that will be called as soon as PHP-FPM response is ready - usually after first echo from the remote PHP script, and maybe after a few more echoes, or at the end of the script (when `g.exit()` called).
		The callback receives a `ResponseWithCookies` object that extends built-in `Response`.
		The response contains headers and body reader, that will read everything echoed from the script.
		In this callback you need to await till you finished working with the response object, as it will be destroyed after this callback ends.
		The returned `ResponseWithCookies` object extends built-in `Response` (that `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
	 **/
	onresponse?: (response: ResponseWithCookies) => Promise<unknown>;

	/**	Callback that catches output of PHP `error_log($msg, 0)` and `error_log($msg, 4)`.
		If not assigned, will print to `Deno.stderr`.
	 **/
	onlogerror?: ((msg: string) => unknown) | undefined;
}

/**	Settings that affect `PhpInterpreter` behavior.
 **/
export class PhpSettings
{	/**	Command that will be executed to spawn a PHP-CLI process. This setting is ignored if `php_fpm.listen` is set.
		Use array to pass command-line arguments together with the command.
	 **/
	php_cli_name: string|string[] = PHP_CLI_NAME_DEFAULT;

	php_fpm: PhpFpmSettings =
	{	listen: '',
		connect_timeout: DEFAULT_CONNECT_TIMEOUT,
		keep_alive_timeout: DEFAULT_KEEP_ALIVE_TIMEOUT,
		keep_alive_max: Number.MAX_SAFE_INTEGER,
		params: new Map,
		request: 'http://localhost/',
		max_conns: 128,
	};

	unix_socket_name = '';

	/**	This library will create socket for communication with PHP process, and bind it to `localhost_name_bind`.
		This host must be discoverable form within PHP process by the name `localhost_name`.
		When using PHP-CLI, or local PHP-FPM, the best choise for `localhost_name_bind` is `localhost` (or `::1` or `127.0.0.1`).
		If communicating with remote PHP-FPM, you can bind to router network ip, or to '0.0.0.0'.
	 **/
	localhost_name = 'localhost';

	/**	See {@link localhost_name}
	 **/
	localhost_name_bind = 'localhost';

	/**	This library uses interpreter script that executes commands sent from Deno end.
		If using PHP-CLI, the default behavior is to pass the whole contents of the interpreter script as command line argument to PHP command.
		If using PHP-FPM, the default behavior is to create temporary file in system temporary directory, write the interpreter script to this file, and pass it's filename to PHP-FPM service.
		In certain circumstances such default behavior is not wanted.
		Another option is to download the interpreter script [from here](https://deno.land/x/php_world@v0.0.23/php/deno-php-world.php),
		install it to your system together with the application, and set the `interpreter_script` setting to the path of this file.
		This file must be accessible by PHP.
		Placing your interpreter script to WWW accessible place must not be a security risk.
		This script will agree to execute commands only if certain parameters are set.
		For PHP-CLI, this script reads parameters from STDIN, and only if `php_sapi_name()` returns `cli`.
		For PHP-FPM, parameters are passed through FastCGI server environment variable called `$_SERVER['DENO_WORLD_HELO']`.
		If your HTTP server is not configured to pass such variable, the interpreter script will not execute commands when is accessed through WWW.
	 **/
	interpreter_script = '';

	stdout: 'inherit'|'piped'|'null' = 'inherit';

	/**	If set to existing PHP file, will chdir() to this file's directory, and execute this file before doing first requested operation (even if it was `g.exit()`).
		If after `g.exit()` another operation is performed, the script will be executed again.
	 **/
	init_php_file = '';

	/**	By default arguments from Deno are passed to PHP.
		Here you can override them.
	 **/
	override_args: string[] | undefined;

	onsymbol: (name: string) => Any = () => {};

	constructor(init_settings?: PhpSettingsInit)
	{	this.php_cli_name = init_settings?.php_cli_name ?? this.php_cli_name;
		this.php_fpm.listen = init_settings?.php_fpm?.listen ?? this.php_fpm.listen;
		this.php_fpm.connect_timeout = init_settings?.php_fpm?.connect_timeout ?? this.php_fpm.connect_timeout;
		this.php_fpm.keep_alive_timeout = init_settings?.php_fpm?.keep_alive_timeout ?? this.php_fpm.keep_alive_timeout;
		this.php_fpm.keep_alive_max = init_settings?.php_fpm?.keep_alive_max ?? this.php_fpm.keep_alive_max;
		this.php_fpm.params = init_settings?.php_fpm?.params ?? this.php_fpm.params;
		this.php_fpm.request = init_settings?.php_fpm?.request ?? this.php_fpm.request;
		this.php_fpm.max_conns = init_settings?.php_fpm?.max_conns ?? this.php_fpm.max_conns;
		this.unix_socket_name = init_settings?.unix_socket_name ?? this.unix_socket_name;
		this.stdout = init_settings?.stdout ?? this.stdout;
		this.init_php_file = init_settings?.init_php_file ?? this.init_php_file;
		this.override_args = init_settings?.override_args;
		this.onsymbol = init_settings?.onsymbol ?? this.onsymbol;
	}
}

export type PhpSettingsInit = Partial<Omit<PhpSettings, 'php_fpm'>> & {php_fpm?: Partial<PhpFpmSettings>};
