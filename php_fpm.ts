import {PhpInterpreter} from './php_interpreter.ts';
import {fcgi, ServerRequest, dirname, iter} from './deps.ts';

const RE_FIX_SCRIPT_FILENAME = /^(?:(?:[\w\-]+:)?[\w\-]+:\/\/[^\/]+)?\/*/; // if SetHandler is used in Apache, it sends requests prefixed with "proxy:fcgi://localhost/", or what appears in the "SetHandler"

// maxConns

export type Options =
{	frontend_listen: string;
	backend_listen: string;
	max_conns?: number;
	keep_alive_timeout?: number;
	keep_alive_max?: number;
	unix_socket_name?: string,
	max_name_length?: number,
	max_value_length?: number,
	max_file_size?: number,
	onisphp?: (script_filename: string) => boolean | Promise<boolean>;
	onsymbol?: (type: string, name: string) => any;
	onrequest?: (request: ServerRequest, php: PhpInterpreter) => Promise<unknown>;
	onerror?: (error: Error) => void;
	onend?: () => void;
};

export function start_proxy(options: Options)
{	if (options.onerror)
	{	fcgi.on('error', options.onerror);
	}

	fcgi.options
	(	{	structuredParams: true,
			maxConns: options.max_conns,
			maxNameLength: options.max_name_length,
			maxValueLength: options.max_value_length,
			maxFileSize: options.max_file_size,
		}
	);

	let listener = fcgi.listen
	(	options.frontend_listen,
		'',
		async request =>
		{	let script_filename = request.params.get('SCRIPT_FILENAME') ?? '';
			script_filename = script_filename.replace(RE_FIX_SCRIPT_FILENAME, '/');

			let php = new PhpInterpreter;
			php.settings.php_fpm.listen = options.backend_listen;
			php.settings.php_fpm.params = request.params;
			php.settings.php_fpm.request = (request.params.get('HTTPS')=='on' ? 'https://' : 'http://') + request.params.get('HTTP_HOST') + request.url;
			if (options.max_conns != undefined)
			{	php.settings.php_fpm.max_conns = options.max_conns;
			}
			if (options.keep_alive_timeout != undefined)
			{	php.settings.php_fpm.keep_alive_timeout = options.keep_alive_timeout;
			}
			if (options.keep_alive_max != undefined)
			{	php.settings.php_fpm.keep_alive_max = options.keep_alive_max;
			}
			if (options.unix_socket_name)
			{	php.settings.unix_socket_name = options.unix_socket_name;
			}
			if (options.onsymbol)
			{	php.settings.onsymbol = options.onsymbol;
			}

			let is_php = options.onisphp ? options.onisphp(script_filename) : script_filename.endsWith('.php');
			if (typeof(is_php) != 'boolean')
			{	is_php = await is_php;
			}

			if (is_php)
			{	php.settings.php_fpm.request_init =
				{	method: request.params.get('REQUEST_METHOD'),
					bodyIter: iter(request.body),
					headers: request.headers
				};
				php.settings.php_fpm.onresponse = async (response) =>
				{	await request.respond
					(	{	status: response.status,
							headers: response.headers,
							setCookies: response.cookies,
							body: response.body ?? undefined, // response body as Deno.Reader
						}
					);
				};
				php.settings.init_php_file = script_filename;
				await php.g.exit();
				return;
			}

			if (options.onrequest)
			{	await request.post.parse();
				await options.onrequest(request, php);
				return;
			}
		}
	);

	fcgi.on
	(	'end',
		() =>
		{	new PhpInterpreter().close_idle();
			options.onend?.();
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
