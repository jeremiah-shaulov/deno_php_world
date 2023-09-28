import {PhpInterpreter, PhpSettings} from './php_interpreter.ts';
import {fcgi, ServerRequest} from './deps.ts';
import {iterateReader} from './util.ts';

const RE_FIX_SCRIPT_FILENAME = /^(?:(?:[\w\-]+:){1,2}\/\/[^\/]+)?(?:\/(?=\/))*/; // if SetHandler is used in Apache, it sends requests prefixed with "proxy:fcgi://localhost/", or what appears in the "SetHandler"

export interface ProxyOptions
{	frontend_listen: string | number;
	backend_listen: string;
	max_conns?: number;
	connect_timeout?: number;
	keep_alive_timeout?: number;
	keep_alive_max?: number;
	unix_socket_name?: string;
	localhost_name?: string;
	localhost_name_bind?: string;
	interpreter_script?: string;
	max_name_length?: number;
	max_value_length?: number;
	max_file_size?: number;
	onrequest: (request: PhpRequest) => Promise<void>;
	onerror?: (error: Error) => void;
}

interface ProxyRequestOptions
{	/**	Callback that catches output of PHP `error_log($msg, 0)` and `error_log($msg, 4)`.
		If not assigned, will print to `Deno.stderr`.
	 **/
	onlogerror?: (msg: string) => unknown;
}

export class PhpRequest extends PhpInterpreter
{	public script_filename: string;

	constructor(public request: ServerRequest)
	{	super();
		const script_filename = request.params.get('SCRIPT_FILENAME');
		this.script_filename = script_filename==undefined ? '' : script_filename.replace(RE_FIX_SCRIPT_FILENAME, '');
		this.settings.php_fpm.request = (request.params.get('HTTPS')=='on' ? 'https://' : 'http://') + request.params.get('HTTP_HOST') + request.url;
	}

	/**	Delegates this request to PHP to be processed there.
		Returns HTTP status code. The response with this code is already sent to the client at this point.
	 **/
	async proxy(options?: ProxyRequestOptions)
	{	let status = 0;
		this.settings.php_fpm.request_init =
		{	method: this.request.params.get('REQUEST_METHOD'),
			bodyIter: iterateReader(this.request.body),
			headers: this.request.headers
		};
		this.settings.php_fpm.onlogerror = options?.onlogerror;
		this.settings.php_fpm.onresponse = async response =>
		{	status = response.status;
			await this.request.respond
			(	{	status: response.status,
					headers: response.headers,
					setCookies: response.cookies,
					body: response.body ?? undefined, // response body as Deno.Reader
				}
			);
		};
		this.settings.init_php_file = this.script_filename;
		await this.g.exit();
		return status;
	}
}

export function start_proxy(options: ProxyOptions)
{	const {frontend_listen, backend_listen, max_conns, connect_timeout, keep_alive_timeout, keep_alive_max, unix_socket_name, localhost_name, localhost_name_bind, interpreter_script, max_name_length, max_value_length, max_file_size, onrequest, onerror} = options;
	const default_settings = new PhpSettings;
	const set_max_conns = max_conns ?? default_settings.php_fpm.max_conns;
	const set_connect_timeout = connect_timeout ?? default_settings.php_fpm.connect_timeout;
	const set_keep_alive_timeout = keep_alive_timeout ?? default_settings.php_fpm.keep_alive_timeout;
	const set_keep_alive_max = keep_alive_max ?? default_settings.php_fpm.keep_alive_max;
	const set_unix_socket_name = unix_socket_name ?? default_settings.unix_socket_name;
	const set_localhost_name = localhost_name ?? default_settings.localhost_name;
	const set_localhost_name_bind = localhost_name_bind ?? default_settings.localhost_name_bind;
	const set_interpreter_script = interpreter_script ?? default_settings.interpreter_script;

	if (onerror)
	{	fcgi.onError(onerror);
	}

	fcgi.options
	(	{	structuredParams: true,
			maxConns: set_max_conns,
			maxNameLength: max_name_length,
			maxValueLength: max_value_length,
			maxFileSize: max_file_size,
		}
	);

	const listener = fcgi.listen
	(	frontend_listen,
		'',
		async request =>
		{	const php = new PhpRequest(request);
			php.settings.php_fpm.listen = backend_listen;
			php.settings.php_fpm.params = request.params;
			php.settings.php_fpm.max_conns = set_max_conns;
			php.settings.php_fpm.connect_timeout = set_connect_timeout;
			php.settings.php_fpm.keep_alive_timeout = set_keep_alive_timeout;
			php.settings.php_fpm.keep_alive_max = set_keep_alive_max;
			php.settings.unix_socket_name = set_unix_socket_name;
			php.settings.localhost_name = set_localhost_name;
			php.settings.localhost_name_bind = set_localhost_name_bind;
			php.settings.interpreter_script = set_interpreter_script;

			try
			{	await onrequest(php);
			}
			finally
			{	await php.g.exit();
			}
		}
	);

	let onend: (() => void) | undefined;
	let onend_promise: Promise<void> | undefined;

	fcgi.onEnd
	(	() =>
		{	new PhpInterpreter().close_idle();
			onend?.();
		}
	);

	const handle =
	{	addr: listener.addr,

		/**	If you call `start_proxy()` several times in application, so running several proxies in parallel,
			the promise that this function returns will resolve after all the proxies finished.
		 **/
		stop()
		{	if (!onend_promise)
			{	onend_promise = new Promise<void>(y => {onend = y});
			}
			fcgi.unlisten(listener.addr);
			return onend_promise;
		}
	};

	return handle;
}
