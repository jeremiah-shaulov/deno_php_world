import {PhpInterpreter, PhpSettings} from './php_interpreter.ts';
import {fcgi, ServerRequest, iter} from './deps.ts';

const RE_FIX_SCRIPT_FILENAME = /^(?:(?:[\w\-]+:){1,2}\/\/[^\/]+)?(?:\/(?=\/))*/; // if SetHandler is used in Apache, it sends requests prefixed with "proxy:fcgi://localhost/", or what appears in the "SetHandler"

export interface ProxyOptions
{	frontend_listen: string;
	backend_listen: string;
	max_conns?: number;
	keep_alive_timeout?: number;
	keep_alive_max?: number;
	unix_socket_name?: string,
	max_name_length?: number,
	max_value_length?: number,
	max_file_size?: number,
	onrequest: (request: PhpRequest) => Promise<void>;
	onerror?: (error: Error) => void;
	onend?: () => void;
}

export class PhpRequest extends PhpInterpreter
{	public script_filename: string;

	constructor(public request: ServerRequest)
	{	super();
		let script_filename = request.params.get('SCRIPT_FILENAME');
		this.script_filename = script_filename==undefined ? '' : script_filename.replace(RE_FIX_SCRIPT_FILENAME, '');
		this.settings.php_fpm.request = (request.params.get('HTTPS')=='on' ? 'https://' : 'http://') + request.params.get('HTTP_HOST') + request.url;
	}

	async proxy()
	{	this.settings.php_fpm.request_init =
		{	method: this.request.params.get('REQUEST_METHOD'),
			bodyIter: iter(this.request.body),
			headers: this.request.headers
		};
		this.settings.php_fpm.onresponse = async (response) =>
		{	await this.request.respond
			(	{	status: response.status,
					headers: response.headers,
					setCookies: response.cookies,
					body: response.body ?? undefined, // response body as Deno.Reader
				}
			);
		};
		this.settings.init_php_file = this.script_filename;
		await this.g.exit();
	}
}

export function start_proxy(options: ProxyOptions)
{	let {frontend_listen, backend_listen, max_conns, keep_alive_timeout, keep_alive_max, unix_socket_name, max_name_length, max_value_length, max_file_size, onrequest, onerror, onend} = options;
	let default_settings = new PhpSettings;
	let set_max_conns = max_conns ?? default_settings.php_fpm.max_conns;
	let set_keep_alive_timeout = keep_alive_timeout ?? default_settings.php_fpm.keep_alive_timeout;
	let set_keep_alive_max = keep_alive_max ?? default_settings.php_fpm.keep_alive_max;
	let set_unix_socket_name = unix_socket_name ?? default_settings.unix_socket_name;

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

	let listener = fcgi.listen
	(	frontend_listen,
		'',
		async request =>
		{	let php = new PhpRequest(request);
			php.settings.php_fpm.listen = backend_listen;
			php.settings.php_fpm.params = request.params;
			php.settings.php_fpm.max_conns = set_max_conns;
			php.settings.php_fpm.keep_alive_timeout = set_keep_alive_timeout;
			php.settings.php_fpm.keep_alive_max = set_keep_alive_max;
			php.settings.unix_socket_name = set_unix_socket_name;

			try
			{	await onrequest(php);
			}
			finally
			{	await php.g.exit();
			}
		}
	);

	fcgi.onEnd
	(	() =>
		{	new PhpInterpreter().close_idle();
			onend?.();
		}
	);

	let handle =
	{	addr: listener.addr,
		stop()
		{	fcgi.unlisten(listener.addr);
		}
	};

	return handle;
}
