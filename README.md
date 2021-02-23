# php_world

This module extends Deno world with PHP, by running commandline PHP interpreter in the background.

There are several possible reasons to use the `php_world`:

1. If you have a large PHP application, and you wish to convert it to Javascript/Typescript, but it's impossible to achieve at once. In this case `php_world` allows you to start writing new code in Javascript/Typescript, and convert each part of the application later, as desired.
2. If you want to benefit from PHP functionality or third-party PHP libraries/SDKs or database drivers.

## Requirements

PHP CLI must be installed on your system.

## Limitations

1. Unfortunately it's impossible to automatically garbage-collect PHP object handles, so `delete` must be used explicitly (see below).
2. On non-Windows, it uses unix-domain socket to communicate with the interpreter, so requires `--unstable` flag.

## Examples

### Usage

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
// ...
// and at last, terminate the interpreter
await g.exit();
```

Run the script like this:

```bash
deno run --unstable --allow-run --allow-read --allow-write --allow-net main.ts
```

`php_world` will execute the `php` CLI command. If in your system the interpreter appears under different name, you need to set it's name before accessing `php_world` interfaces.

```ts
import {g, c, settings} from 'https://deno.land/x/php_world/mod.ts';

settings.php_cli_name = 'php7.4';
// now access php_world interfaces
// ...
// and at last, terminate the interpreter
await g.exit();
```

### Interface

There are 2 logical namespaces:

1. `g` contains all the PHP functions, global constants and variables.
2. `c` contains classes.

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

At the end of Deno script, it's nice to call `exit()`. This function terminates the interpreter, and frees all the resources. After this function called, the `php_world` can be used again, and a new instance of the interpreter will be spawned. It's OK to call `exit()` several times.

If function's result is not awaited-for, the function will work in the background, and if it throws exception, this exception will come out on next operation awaiting. After exception occures, all further operations in current microtask iteration will be skipped (see below).

### Global constants

Constant's value must be awaited-for.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

console.log(await g.PHP_VERSION);
console.log((await g.FAKE) === undefined); // unexisting constants have "undefined" value
```

### Global variables

Like constants, variables are present in the `g` namespace, but their names must begin with a '$'.

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

To create a class instance, call the constructor, and await the result. It returns handler to remote PHP object.

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

However it's possible to get object handler as in example with instance construction. To do so need to get special property called `this` from the object, before awaiting for the result.

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

At last, the object must be deleted. This doesn't necessarily destroys the object on PHP side, but it stops holding the handler to the object.

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

### Exceptions

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

The InterpreterError class has the following fields: `message`, `fileName`, `lineNumber`, `trace` (string).

If a function throws exception, and you don't await for the result, it's error will be returned to the next awaited operation within current microtask iteration.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

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
{	await g.$n; // throws error 'Test 1'
}
catch (e)
{	console.log(e.message); // prints 'Test 1'
}
console.log(await g.$n); // prints 1
```

But if you don't await any other `php_world` operation within the current microtask iteration, the exception will be lost.

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';

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
		{	await g.$n; // throws error 'Test 2'
		}
		catch (e)
		{	console.log(e.message); // prints 'Test 2'
		}
		console.log(await g.$n); // prints 2
	}
);
```

### Running several PHP interpreters in parallel

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
