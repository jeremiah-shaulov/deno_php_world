# php_world

This module extends Deno world with PHP, by running commandline PHP interpreter in the background.

There are several possible reasons to use the `php_world`:

1. If you have a large PHP application, and you wish to convert it to Javascript/Typescript, but it's impossible to achieve at once. In this case `php_world` allows you to start writing new code in Javascript/Typescript, and convert each part of the application later, as desired.
2. If you want to benefit from PHP functionality or third-party PHP libraries/SDKs or database drivers.

## Requirements

PHP CLI must be installed on your system, and the `php` command must correspond to the PHP interpreter.

## Limitations

1. Unfortunately it's impossible to automatically garbage-collect PHP object handles, so `delete` must be used explicitly (see below).
2. Requires `--unstable` flag, like `deno run --unstable --allow-run --allow-read --allow-write ...`.

## Examples

### Usage

```ts
import {g, c} from 'https://deno.land/x/php_world/mod.ts';
// ...
// and at last, terminate the interpreter
await g.exit();
```

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

Each instance created with `new`, must be destroyed with `delete`.

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
