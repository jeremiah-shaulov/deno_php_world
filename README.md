# php_world

This module extends Deno world with PHP, by running command-line PHP interpreter in background, or by connecting to a PHP-FPM service.

There are several possible reasons to use `php_world`:

1. If you have a large PHP application, and you wish to convert it to Javascript/Typescript, but it's impossible to achieve at once. In this case `php_world` allows you to start writing new code in Javascript/Typescript, and convert each part of the application later, as desired.
2. If you want to benefit from PHP functionality or third-party PHP libraries/SDKs or database drivers.

## Requirements

PHP-CLI or PHP-FPM must be installed on your system.

## Limitations

1. Unfortunately it's impossible to automatically garbage-collect PHP object handles, so `delete` must be used explicitly (see below). However there are helper methods.

## Examples

### Usage

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
// ...
// and at last, terminate the interpreter
await g.exit();
```

Run the script as follows:

```bash
deno run --unstable --allow-net --allow-run=php main.ts
```

By default `php_world` will execute `php` CLI command.
If in your system PHP appears under different name, you need to set `settings.php_cli_name` before accessing `php_world` interfaces.
If you wish to use PHP-FPM instead, set `settings.php_fpm.listen`.

```ts
import {g, c, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.php_cli_name = 'php7.4';
// now access php_world interfaces
// ...
// and at last, terminate the interpreter
await g.exit();
```
There are several configurable settings:

1. `settings.php_cli_name` - PHP-CLI command name (default `php`).
2. `settings.unix_socket_name` - `php_world` uses socket channel to communicate with the remote interpreter. By default it uses random (free) TCP port. On non-Windows systems you can use unix-domain socket. Set `settings.unix_socket_name` to full path of socket node file, where it will be created.
3. `settings.stdout` - Allows to redirect PHP process echo output (see below).
4. `settings.php_fpm.listen` - If set, `php_world` will use PHP-FPM service, not CLI. Set this to what appears in your PHP-FPM pool configuration file (see line that contains `listen = ...`).
5. `settings.php_fpm.*` - There are some more PHP-FPM related settings that will be explained below.
6. `settings.init_php_file` - Path to PHP script file. If specified, will `chdir()` to it's directory, and execute this script as part of initialization process.
7. `settings.interpreter_script` - Use manually installed interpreter script (by default will use embedded one).
7. `onsymbol` - Callback that resolves Deno world entities, that can be accessed from PHP.

### Interface

`php_world` library exports the following symbols:

1. `PhpInterpreter` - Constructor for new PHP interpreter to run in the background.
2. `php` - Default interpreter (created with `new PhpInterpreter`).
3. `g` - The same as `php.g`. Contains all the PHP functions, global constants and variables.
4. `c` - The same as `php.c`. Contains classes.
5. `settings` - The same as `php.settings`. Allows to modify interpreter settings.
6. `InterpreterError` - Class for exceptions propagated from PHP.
7. `InterpreterExitError` - This error is thrown in case PHP interpreter exits or crashes.
8. `start_proxy` - Function that creates FastCGI proxy node between Web server and PHP-FPM, where PHP script can access Deno environment, and vise versa.

### Calling functions

Each function becomes async, because calling it involves IPC (interprocess communication) with the background PHP interpreter.

```ts
import {g} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval, phpversion, class_exists, exit} = g;

console.log(await phpversion());
await php_eval('class Hello {}');
console.log(await class_exists('Hello'));
await exit();
```

It's important to call `exit()` at the end of Deno script. This function terminates the interpreter, and frees all the resources. After this function called, `php_world` can be used again, and a new interpreter instance will be spawned. It's OK to call `exit()` several times.

### Global constants

Constant's value must be awaited-for.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

console.log(await g.PHP_VERSION);
console.log((await g.FAKE) === undefined); // unexisting constants have "undefined" value
```

### Global variables

Like constants, variables are present in the `g` namespace, but their names begin with '$'.

Variable's value must be awaited-for. But setting new value returns immediately (and doesn't imply synchronous operations - the value will be set in the background, and there's no result that we need to await for).

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

console.log((await g.$ten) === undefined); // unexisting variables have "undefined" value
g.$ten = 10;
console.log(await g.$ten);
```

Individual keys can be accessed.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

g.$_SERVER['hello']['world'] = true;
console.log(await g.$_SERVER['hello']);
```

It's possible to unset a key.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

console.log(await g.$_SERVER['argc']); // likely to print '1'
delete g.$_SERVER['argc'];
console.log((await g.$_SERVER['argc']) === undefined); // prints "true"
```

### Classes

Classes are present in the `c` namespace.

### Class-static constants

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval('class Value {const TEN = 10;}');
console.log((await Value.NINE) === undefined); // unexisting constants have "undefined" value
console.log(await Value.TEN);
```

### Class-static variables

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval('class Value {static $ten = 10;}');
console.log((await Value.$nine) === undefined); // unexisting variables have "undefined" value
console.log(await Value.$ten);
```

### Class-static methods

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval
(	`	class Value
		{	static function get_ten()
			{	return 10;
			}
		}
	`
);
console.log(await Value.get_ten());
```

### Class construction and destruction

To create a class instance, call class constructor, and await for the result. It returns handle to remote PHP object.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval('class Value {}');
let value = await new Value;
```

Each instance created with `new`, must be destroyed with `delete`. Special property `this` must be deleted (because just `delete obj` is invalid syntax in strict mode).

```ts
delete value.this;
```
For debugging purposes it's possible to query number of currently allocated objects. This number must reach 0 at the end of the script.

```ts
import {g, c, php} from 'https://deno.land/x/php_world/mod.ts';

console.log(await php.n_objects()); // prints 0
let obj = await new c.Exception('Test');
console.log(await php.n_objects()); // prints 1
delete obj.this;
console.log(await php.n_objects()); // prints 0
```
To help you free memory, there're 2 helper functions:

1. `php.push_frame()` - All objects allocated after this call, can be freed at once.
2. `php.pop_frame()` - Free at once all the objects allocated after last `php.push_frame()` call.

```ts
import {g, c, php} from 'https://deno.land/x/php_world/mod.ts';

php.push_frame();
try
{	let obj = await new c.Exception('Test');
	console.log(await php.n_objects()); // prints 1
}
finally
{	php.pop_frame();
	console.log(await php.n_objects()); // prints 0
}
```

### Instance variables

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval('class Value {public $ten;}');
let value = await new Value;
value.ten = 10;
console.log(await value.ten);
delete value.this;
```

### Instance methods

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
const {eval: php_eval} = g;
const {Value} = c;

await php_eval
(	`	class Value
		{	public $var;

			function get_twice_var()
			{	return $this->var * 2;
			}
		}
	`
);
let value = await new Value;
value.var = 10;
console.log(await value.get_twice_var());
delete value.this;
```

### Objects returned from functions

When a function is called, and returned a value, this value is JSON-serialized on PHP side, and JSON-parsed in the Deno world.
Objects returned from functions are dumb default objects, without methods.

However it's possible to get object handle as in example with instance construction. To do so you need to get special property called `this` from the object, before awaiting for the result.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	function get_ex($msg)
		{	return new Exception($msg);
		}
	`
);

let ex = await g.get_ex('The message').this;
console.log(await ex.getMessage()); // prints 'The message'
delete ex.this;
```

At last, the object must be deleted. This doesn't necessarily destroy the object on PHP side, but it stops holding a reference to the object.

### Get variables as objects

In the same fashion, it's possible to get object-handle to a variable.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	global $e;
		$e = new Exception('The message');
	`
);

let ex = await g.$e.this;
console.log(await ex.getMessage()); // prints 'The message'
delete ex.this;
```

### Objects behavior

Remote PHP objects are represented in Deno as opaque `Proxy` objects, and they don't feel like real Typescript objects. Most of magic behavior is missing. For example they don't convert to strings automatically (because `toString()` magic method is synchronous). Only the following object features work:

1. Getting, setting and deleting properties.
2. `instanceof` operator.
3. Async iterators.

Example:

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

let obj = await new c.ArrayObject(['a', 'b', 'c']);
console.log(obj instanceof c.ArrayObject); // prints "true"
for await (let item of obj)
{	console.log(item);
}
delete obj.this;
```

### Namespaces

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	namespace MainNs;

		function get_twice($value)
		{	return $value * 2;
		}

		class Value
		{	public $var;

			function get_triple_var()
			{	return $this->var * 3;
			}
		}
	`
);

console.log(await g.MainNs.get_twice(10));

let value = await new c.MainNs.Value;
value.var = 10;
console.log(await value.get_triple_var());
delete value.this;
```

### Accessing Deno world from PHP

When you pass an object from Deno to PHP, and this object is not a plain `Object` or `Array` (`obj.constructor!=Object && obj.constructor!=Array`), a handler to remote Deno object is created on PHP side.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

class FirstClass
{	get_value()
	{	return 'the value';
	}
}

g.$first_class = new FirstClass;

await g.eval
(	`	global $first_class;

		var_dump($first_class->get_value()); // prints: string(9) "the value"
	`
);
await g.exit();
```

Also on PHP side 2 global variables get automatically defined at the beginning of the script: `$globalThis` and `$window`. They are identical, so you can use whatever you prefer.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	global $window;

		var_dump($window->parseInt('123px'));

		var_dump($window->Math->pow(10, 3));

		var_dump($window->Deno->pid);

		var_dump($window->eval('Deno.pid'));
	`
);
await g.exit();
```

When accessing async values, they're automatically awaited.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	global $window;

		var_dump($window->fetch('http://example.com/')->text());
	`
);
await g.exit();
```

Javascript functions and classes are not distinguishable entities (functions can be used as classes). They both can be referred to from PHP through `DenoWorld` namespace.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	global $keys_func;

		use DenoWorld\\Map;

		$m = new Map;
		$m->set('k1', 'v1');
		$m->set('k2', 'v2');

		var_dump($m->size);
		var_dump(count($m));
		var_dump(iterator_to_array($m->keys()));
		$keys_func = $m->keys->bind($m);
	`
);
let keys_func = await g.$keys_func;
console.log([...keys_func()]);
await g.exit();
```

Some class names are invalid in PHP, and cause errors. Classes called "Array" and "Object" are such.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

try
{	await g.eval
	(	`	var_dump(new DenoWorld\\Array('a', 'b', 'c'));
		`
	);
}
catch (e)
{	console.error(e); // Error: syntax error, unexpected 'Array' (T_ARRAY), expecting identifier (T_STRING)
}

await g.exit();
```

But you can rename them.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	global $window;

		$window->Arr = $window->Array;
		$a = new DenoWorld\\Arr('a', 'b', 'c');
		var_dump($a);
		$a->splice(1, 1, 'B', 'B');
		var_dump($a);
		var_dump($window->JSON->stringify($a));
	`
);

await g.exit();
```

The following object features are supported:

1. Getting and setting properties. They can be accessed as `$obj->prop` or `$obj['prop']`.
2. `isset($obj->prop)` and `unset($obj->prop)`.
3. Calling object methods. And calling objects as functions (like `$window->Number('123')`), if this makes sense.
4. When converting a Deno-world object to string, it's `toString()` will be called on Deno side.
5. `foreach` iteration. If Deno object has `Symbol.iterator` or `Symbol.asyncIterator`, they will be used. Otherwise object properties will be iterated (as usual in PHP).
6. If Deno object has property called `length`, or `size`, `count($obj)` will return it's value.

If a requested Deno class doesn't exist, you can handle this situation, and maybe load it before accessing.

```ts
import {g, c, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.onsymbol = name =>
{	if (name == 'Scientific')
	{	class Scientific
		{	constructor(public n=0)
			{
			}

			twice()
			{	return this.n*2;
			}
		}
		return Scientific;
	}
};

await g.eval
(	`	use DenoWorld\\Scientific;

		$obj = new Scientific(10);
		var_dump($obj->twice());
	`
);

await g.exit();
```

To access toplevel functions that are not in `globalThis`, but must be handled by `onsymbol()`, you can call them as static functions of `DenoWorld` class.

```ts
import {g, c, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.onsymbol = name =>
{	if (name == 'hello')
	{	function hello()
		{	return 'hello';
		}
		return hello;
	}
};

await g.eval
(	`	var_dump(DenoWorld::hello());
	`
);

await g.exit();
```

If a Deno object has method called `dispose()`, it will be called once this object becomes not in use on PHP side.

```ts
import {php} from 'https://deno.land/x/php_world/mod.ts';

class MyFile
{	protected fh: Deno.File | undefined;
	private buffer = new Uint8Array(8*1024);

	static async open(path: string, options?: Deno.OpenOptions)
	{	let self = new MyFile;
		self.fh = await Deno.open(path, options);
		return self;
	}

	dispose()
	{	this.fh?.close();
	}

	async read()
	{	let n = await this.fh?.read(this.buffer);
		return n==null ? null : new TextDecoder().decode(this.buffer.subarray(0, n));
	}
}

php.settings.onsymbol = name =>
{	switch (name)
	{	case 'MyFile': return MyFile;
	}
};

php.g.eval
(	`	$f = DenoWorld\\MyFile::open('/etc/passwd');
		while (($chunk = $f->read()) !== null)
		{	echo $chunk;
		}
	`
);
```

Third and the last PHP global variable that this library defines is called `$php`. It contains reference to current PHP interpreter on Deno side (instance of `PhpInterpreter`).
You can pass it to Deno functions, if they want to use current PHP interpreter that called them.

```ts
import {g, c, settings, PhpInterpreter} from 'https://deno.land/x/php_world/mod.ts';

settings.onsymbol = name =>
{	if (name == 'get_rating')
	{	return get_rating;
	}
};

async function get_rating(php: PhpInterpreter)
{	return await php.g.str_repeat('*', await php.g.$cur_rating);
}

await g.eval
(	`	global $php, $cur_rating;

		$cur_rating = 5;

		var_dump(DenoWorld::get_rating($php));
	`
);

await g.exit();
```

For informational purposes there's function that returns number of deno objects, that PHP-side currently holds.
Initially there're 2: $php and $globalThis ($window === $globalThis).
As you request Deno objects, this number will grow, and once you free references, this number will be decreased.

```ts
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
```

### Execution flow and exceptions

When you call PHP functions, if function's result is not awaited-for, the function will work in background. You can continue calling functions, and they all will be executed in the same sequence they requested. If a function threw exception, all subsequent operations will be skipped till the end of current microtask iteration.

```ts
import {g, c, php} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	function failure($msg)
		{	global $n;
			$n++;
			throw new Exception($msg);
		}
	`
);

g.failure('Test 1'); // $n gets the value of 1
g.failure('Test 2'); // this will no be executed, so $n will remain 1
g.failure('Test 3'); // not executed
try
{	// await for anything will throw exception
	// we can use php.ready() to just await for all pending operations
	await php.ready();
}
catch (e)
{	console.log(e.message); // prints 'Test 1'
}
console.log(await g.$n); // prints 1
```

If you don't await any operation within current microtask iteration, the exception will be lost.

```ts
import {g, c, php} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	function failure($msg)
		{	global $n;
			$n++;
			throw new Exception($msg);
		}
	`
);

g.failure('Test 1'); // $n gets the value of 1
queueMicrotask
(	async () =>
	{	g.failure('Test 2'); // $n gets the value of 2
		g.failure('Test 3'); // this will no be executed, so $n remains 2
		try
		{	await php.ready(); // throws error 'Test 2'
		}
		catch (e)
		{	console.log(e.message); // prints 'Test 2'
		}
		console.log(await g.$n); // prints 2
	}
);
```

PHP exceptions are propagated to Deno as instances of InterpreterError class.

```ts
import {g, c, InterpreterError} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	function failure($msg)
		{	throw new Exception($msg);
		}
	`
);

try
{	await g.failure('Test');
}
catch (e)
{	console.log(e instanceof InterpreterError);
	console.log(e.message);
}
```

InterpreterError has the following fields: `message`, `fileName`, `lineNumber`, `phpStack` (string).
Also `stack` field is modified to contain traces from PHP.

If PHP interpreter exits (not as result of calling `g.exit()`), `InterpreterExitError` exception is thrown.

```ts
import {g, InterpreterExitError} from 'https://deno.land/x/php_world/mod.ts';

try
{	await g.eval('exit(100);');
}
catch (e)
{	if (e instanceof InterpreterExitError)
	{	console.log(`PHP exited with code ${e.code}`);
	}
}
```

The InterpreterExitError class has the following fields: `message`, `code` (process exit status code).

### Running several PHP interpreters in parallel

Exported `php` symbol is a default instance of `PhpInterpreter` class that created by calling `export const php = new PhpInterpreter` inside the library. `PhpInterpreter` class allows you to run more instances of PHP interpreter, either PHP-CLI, or PHP-FPM.

```ts
import {g, c, PhpInterpreter} from 'https://deno.land/x/php_world/mod.ts';

let int_1 = new PhpInterpreter;
let int_2 = new PhpInterpreter;

let pid_0 = await g.posix_getpid();
let pid_1 = await int_1.g.posix_getpid();
let pid_2 = await int_2.g.posix_getpid();

console.log(`${pid_0}, ${pid_1}, ${pid_2}`);

await g.exit();
await int_1.g.exit();
await int_2.g.exit();
```

### Limitations of PHP-CLI

Using PHP-CLI backend is simple, but there are disadvantages.

If some PHP script file declares a function, or some other kind of object, such file cannot be included (or required) multiple times. PHP complains on "Cannot redeclare function". Practically this means that to execute the same script multiple times, new PHP interpreters must be spawned. Respawning process is slow, and you will not benefit from opcache.

However, it's possible to reorganize the application in such a way, that script files you run directly don't declare objects, but call `require_once()` for files that do declare them.

Another disadvantage is that functions like `header()` and `setcookie()` do nothing in PHP-CLI.

### Using PHP-FPM

To use PHP-FPM backend (that must be installed on your system), set `settings.php_fpm.listen` to PHP-FPM service address. You can find it in your PHP-FPM pool configuration file.

To get started you can create a new pool file like this (substitute `username` with the user from which you run your deno script):

```ini
[username]
user = username
group = username
listen = [::1]:8989

; if "listen" is unix-domain socket, set also the following:
;listen.owner = username
;listen.group = username

pm = dynamic
pm.max_children = 5
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
```

```ts
import {g, c, php, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.php_fpm.listen = '[::1]:8989';
console.log(await g.php_sapi_name());
await g.exit(); // in case of PHP-FPM, g.exit() doesn't actually call exit() on PHP side, but it terminates a FCGI request
php.close_idle(); // close idle connection to PHP-FPM (otherwise deno script will not exit immediately)
```

Common problems:

1. If using unix-domain socket for PHP-FPM service, it must be accessible by deno script. In PHP-FPM pool configuration one of `listen.owner` or `listen.group` must be set to deno script user.
2. If using unix-domain socket for communication with PHP world (`settings.unix_socket_name`), it must be accessible by PHP interpreter. One of `user` or `group` must be set to deno script user.

If `settings.stdout` is set to `inherit` (default value), echo output, together with headers set with `header()` or `setcookie()` can be taken as `Response` object.

```ts
import {g, c, php, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.php_fpm.listen = '[::1]:8989';

php.g.echo(`Hello`);

await php.g.exit();
php.close_idle();
```

Each `PhpInterpreter` instance (including the default one, that was used in the example above) establishes connection with PHP-FPM service by making a FastCGI request to it.
PHP script will run till you call `g.exit()`. In case of PHP-FPM `g.exit()` works specially: it doesn't call `exit()` on PHP side, but it terminates the FastCGI request.
PHP `echo` output will be received as FastCGI response. The response can start arriving before you call `g.exit()` - usually it happens after echoing some portion of output.

The response can be caught and examined in a callback function set to `settings.php_fpm.onresponse`.
This callback will be called when headers and the first portion of body were received.
The callback will get `ResponseWithCookies` object that is subclass of `Response` (that built-in `fetch()` returns).
This object will contain headers and body reader, that you can use to read everything echoed from the script.

If you want to read the response body in the callback, you need not return till you read all the response body. After returning from the callback, the response can be destroyed (it will be destroyed if you called `g.exit()` earlier).

The body can be read in regular way, as you do with `fetch()`, or it can be read as `Deno.Reader`, because `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.

```ts
import {g, c, php, settings} from 'https://deno.land/x/php_world/mod.ts';
export {readAll} from 'https://deno.land/std@0.135.0/streams/conversion.ts';

settings.php_fpm.listen = '/run/php/php-fpm.jeremiah.sock';
settings.php_fpm.onresponse = async response =>
{	console.log(response.headers);
	if (response.body)
	{	let body = await readAll(response.body);
		console.log('BODY: ' + new TextDecoder().decode(body));
	}
};

await g.eval
(	`	header('X-Hello: All');
		echo "Response body";
	`
);

console.log('Essentially this is it');
await g.exit();
console.log('Exited');
php.close_idle();
```

By default this library reuses connections to PHP-FPM. This can be controlled by adjusting `settings.php_fpm.keep_alive_timeout`.
This number of milliseconds each connection will remain idle after the request, so Deno script would not exit naturally if you don't call `php.close_idle()`.

### Creating FastCGI proxy

If you have Apache (or Nginx) + PHP-FPM setup, you can create Deno node in the middle, so Apache will connect to your Deno application, and it will proxy the request further to PHP-FPM.
And by default this will work as there was no Deno at all. But PHP scrips will be able to access Deno world, and vise versa.

```ts
import {start_proxy, PhpRequest} from 'https://deno.land/x/php_world/mod.ts';

console.log(`Server started`);

let proxy = start_proxy
(	{	frontend_listen: '/tmp/jeremiah.sock',
		backend_listen: '/run/php/php-fpm.jeremiah.sock',
		max_conns: 128,
		keep_alive_timeout: 10_000,
		keep_alive_max: Number.MAX_SAFE_INTEGER,
		unix_socket_name: '',
		max_name_length: 256,
		max_value_length: 4*1024, // "HTTP_COOKIE" param can have this length
		max_file_size: 10*1024*1024, // is respected by `php.request.post.parse()`
		async onrequest(php: PhpRequest)
		{	// Log incoming request
			console.log(php.request.url);

			// Register Deno-world symbol resolver
			php.settings.onsymbol = name =>
			{	switch (name)
				{	// ...
				}
			};

			// If .php file, forward the request to PHP-FPM
			if (php.script_filename.endsWith('.php'))
			{	await php.proxy(); // PHP gets this request, and sends the response to client
				return;
			}

			// If other kind of file, handle it, or just ignore to return 404
			if (php.request.url.startsWith('/page-1.html'))
			{	// If we want to access POST parameters and uploaded files, we need to call `parse()` (otherwise request.post will contain nothing)
				await php.request.post.parse();

				// Generate the response
				php.request.responseHeaders.set('content-type', 'text/html');
				await php.request.respond({status: 200, body: 'Page 1'});
			}
		},
		onerror(error: Error)
		{
		}
	}
);
```

For each incoming request `onrequest()` will be called, where you can do one of 3 things:
1. call `await php.proxy()` to forward the request to backend PHP-FPM
2. Handle the request manually
3. Do nothing (without awaiting), to let the library generate 404 response

The `onrequest()` callback gets 1 argument of type `PhpRequest` that extends `PhpInterpreter`. It has 2 extra fields:
1. `script_filename: string` - requested script file. It's the same as `this.request.params.get('SCRIPT_FILENAME')`, but cannot be undefined.
2. `request: ServerRequest` - contains information about incoming request: it's headers, GET and POST parameters, cookies and uploaded files.

To handle incoming request, you need to call `await request.respond()` with optional `status: number`, `headers: Headers`, `setCookies: SetCookies` and `body: Uint8Array | Deno.Reader | string`.

For more information on `ServerRequest` object see [x/fcgi](https://deno.land/x/fcgi) library.

`start_proxy()` returns handle, that has `addr: Deno.Addr` of the frontend listener, and method `stop()` that will terminate the proxy. `stop()` returns promise that will be fullfilled after all the requests are completed.

### Dealing with PHP echo output

There's setting that provides control on how PHP output is processed: `settings.stdout`.

```ts
stdout: 'inherit'|'piped'|'null'|number = 'inherit'
```
It's default value is `inherit`. For PHP-CLI this value means to pass PHP output to Deno. So `g.echo("msg\n")` works like `console.log("msg")`.

As usual, it's possible to use PHP output buffering to catch the output.

```ts
import {g} from 'https://deno.land/x/php_world/mod.ts';

g.ob_start();
g.echo("A");
g.echo("B");
g.echo("C");
let output = await g.ob_get_clean();
console.log(output); // prints "ABC"

await g.exit();
```
But this is not good for large outputs, because the whole output will be stored in RAM.

Setting `settings.stdout` to `piped` allows to catch PHP output. Initially the output will be passed to Deno, as in the `inherit` case, but you'll be able to call `php.get_stdout_reader()` to get `Deno.Reader` object from which the output can be read. To stop reading the output from that reader, and to redirect it back to `Deno.stdout`, call `php.drop_stdout_reader()`. This will cause the reader stream to end (`EOF`).

```ts
import {php, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.stdout = 'piped';

let stdout = await php.get_stdout_reader();
php.g.echo("*".repeat(10)); // no await
php.g.echo("."); // queue another function call
php.drop_stdout_reader(); // reader stream will end here

let data = new TextDecoder().decode(await Deno.readAll(stdout));
console.log(data == "*".repeat(10)+"."); // prints "true"

await php.g.exit();
```

This technique doesn't work good with PHP-FPM, because output can be buffered in the middle between PHP and Deno.

Another options for `settings.stdout` are `null` (to ignore the output), and a numeric file descriptor (rid) of an opened file/stream.

### Interpreter script

This library uses interpreter script that executes commands sent from Deno end.

If using PHP-CLI, the default behavior is to pass the whole contents of the interpreter script (that is embedded to this library) as command line argument to PHP command.

If using PHP-FPM, the default behavior is to create temporary file in system temporary directory, write the interpreter script to this file, and pass it's filename to PHP-FPM service.

In certain circumstances such default behavior is not wanted.
Another option is to download the interpreter script [from here](https://deno.land/x/php_world@v0.0.23/php/deno-php-world.php),
install it to your system together with the application, and set `settings.interpreter_script` setting to the path of this file.
This file must be accessible by PHP.

Placing your interpreter script to WWW accessible place must not be a security risk.
This script will agree to execute commands only if certain parameters are set.
For PHP-CLI, this script reads parameters from STDIN, and only if `php_sapi_name()` returns `cli`.
For PHP-FPM, parameters are passed through FastCGI server environment variable called `$_SERVER['DENO_WORLD_HELO']`.
If your HTTP server is not configured to pass such variable, the interpreter script will not execute commands when is accessed through WWW.

### How fast is deno_world?

`deno_world` spawns a background PHP process, and uses it to execute PHP operations. Every operation, like function call, or getting or setting a variable, sends requests to the PHP process and awaits for responses.

First of all, spawning takes time, but it happens once (or several times if your application calls `g.exet()` to terminate the interpreter, and then uses the interpreter again). Then every request to execute an operation, not only executes it, but implies many other operations.

What price you pay depends on operation weight. Executing many lightweight operations implies much overhead. And vise versa, if calling PHP functions that do a lot of work, the commission will be negligible.

Understanding this, lets measure the overhead of average `deno_world` API call.

How much time takes to call the following function in PHP?

```php
function dec()
{	global $n;
	return $n--;
}
```
Let's use this time as a measuring unit, and measure how slower is `deno_world` over native PHP.

```ts
import {g} from 'https://deno.land/x/php_world/mod.ts';

await g.eval
(	`	function dec()
		{	global $n;
			return $n--;
		}

		function php_ops_per_sec(int $bench_times)
		{	global $n;
			$n = $bench_times;
			$start_time = microtime(true);
			while (dec());
			return $bench_times / (microtime(true) - $start_time);
		}
	`
);

let {php_ops_per_sec, dec} = g;

async function deno_ops_per_sec(bench_times: number)
{	g.$n = bench_times;
	let start_time = Date.now() / 1000;
	while (await dec());
	return bench_times / (Date.now()/1000 - start_time);
}

let php_native_time = await php_ops_per_sec(10_000_000);
console.log(`PHP native: ${php_native_time} ops/sec`);

let api_time = await deno_ops_per_sec(100_000);
console.log(`API: ${api_time} ops/sec, (${Math.round(php_native_time/api_time)} times slower)`);
```
On my computer i get the following result:

```
PHP native: 6447752.089756534 ops/sec
API: 26301.94602735204 ops/sec, (245 times slower)
```
This is for the most elementary operation that we can measure. What if this operation would be heavier?

```php
function dec()
{	global $n, $v;
	$v = base64_encode('0123456789ABCDEF0123456789ABCDEF');
	return $n--;
}
```
The results on my computer are these:

```
PHP native: 3049521.541919448 ops/sec
API: 24679.170501055585 ops/sec, (124 times slower)
```

And for a much slower operation?

```php
function dec()
{	global $n, $v;
	$v = base64_encode(str_repeat('*', 25600));
	return $n--;
}
```
Results (php_ops_per_sec(1_000_000) and deno_ops_per_sec(10_000)):

```
PHP native: 57892.50582551152 ops/sec
API: 16806.72188093417 ops/sec, (3 times slower)
```
