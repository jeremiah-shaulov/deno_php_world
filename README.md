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
import {f, g, c} from './mod.ts';
// ...
// and at last, terminate the interpreter
await f.exit();
```

There are 3 logical namespaces:

1. `f` contains all the PHP functions.
2. `g` contains global constants and variables.
3. `c` contains classes.

### Calling functions

Each function becomes async, because calling it involves IPC (interprocess communication) with the background PHP interpreter.

```ts
import {f} from './mod.ts';
const {eval: php_eval, phpversion, class_exists, exit} = f;

console.log(await phpversion());
await php_eval('class Hello {}');
console.log(await class_exists('Hello'));
await exit();
```

At the end of Deno script, it's nice to call `exit()`. This function terminates the interpreter, and frees all the resources. After this function called, the `php_world` can be used again, and a new instance of the interpreter will be spawned. It's OK to call `exit()` several times.

### Global constants

Constant's value must be awaited-for.

```ts
import {f, g, c} from './mod.ts';

console.log(await g.PHP_VERSION);
console.log((await g.FAKE) === undefined); // unexisting constants have "undefined" value
```

### Global variables

Like constants, variables are present in the `g` namespace, but their names must begin with a '$'.

Variable's value must be awaited-for. But setting new value returns immediately.

```ts
import {f, g, c} from './mod.ts';

console.log((await g.$ten) === undefined); // unexisting variables have "undefined" value
g.$ten = 10;
console.log(await g.$ten);
```

### Classes

Classes are present in the `c` namespace.

### Class-static constants

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

await php_eval('class Value {const TEN = 10;}');
console.log((await Value.NINE) === undefined); // unexisting constants have "undefined" value
console.log(await Value.TEN);
```

### Class-static variables

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

await php_eval('class Value {static $ten = 10;}');
console.log((await Value.$nine) === undefined); // unexisting variables have "undefined" value
console.log(await Value.$ten);
```

### Class-static methods

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

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
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

await php_eval('class Value {}');
let value = await new Value;
```

Each instance created with `new`, must be destroyed with `delete`.

```ts
delete value.this;
```

### Instance variables

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

await php_eval('class Value {public $ten;}');
let value = await new Value;
value.ten = 10;
console.log(await value.ten);
delete value.this;
```

### Instance methods

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {Value} = c;

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

### Namespaces

```ts
import {f, g, c} from './mod.ts';
const {eval: php_eval} = f;
let {MainNs} = c;

await php_eval
(	`	namespace MainNs;

		class Value
		{	public $var;

			function get_twice_var()
			{	return $this->var * 2;
			}
		}
	`
);
let value = await new MainNs.Value;
value.var = 10;
console.log(await value.get_twice_var());
delete value.this;
```

### Running several PHP interpreters in parallel

```ts
import {f, g, c, PhpInterpreter} from './mod.ts';

let int_1 = new PhpInterpreter;
let int_2 = new PhpInterpreter;

let pid_0 = await f.posix_getpid();
let pid_1 = await int_1.f.posix_getpid();
let pid_2 = await int_2.f.posix_getpid();

console.log(`${pid_0}, ${pid_1}, ${pid_2}`);

await f.exit();
await int_1.f.exit();
await int_2.f.exit();
```
