import {g, c, php, settings, PhpInterpreter, InterpreterExitError} from '../mod.ts';
import {assert, assertEquals, sleep, readAll, fcgi, ServerRequest} from "../deps.ts";
import {PhpSettings} from '../php_interpreter.ts';
import {start_proxy, PhpRequest} from '../start_proxy.ts';

const {eval: php_eval, ob_start, ob_get_clean, echo, json_encode, exit} = g;
const {MainNs, C} = c;
const PHP_FPM_LISTEN = '/run/php/php-fpm.jeremiah.sock';
const UNIX_SOCKET_NAME = '/tmp/deno-php-world-test.sock';

class DenoA
{	constructor(public a: any)
	{
	}
}

class DenoArray extends Array
{	constructor(...args: any)
	{	super(...args);
	}
}

function *settings_iter(settings: PhpSettings)
{	for (let listen of ['', PHP_FPM_LISTEN])
	{	settings.php_fpm.listen = listen;
		settings.unix_socket_name = '';
		settings.stdout = 'inherit';
		yield;
		settings.stdout = 'piped';
		yield;
		settings.stdout = 'null';
		yield;
		settings.stdout = 1;
		yield;
		if (listen == '')
		{	settings.unix_socket_name = UNIX_SOCKET_NAME;
			yield;
		}
	}
}

Deno.test
(	'Exit',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await exit();
			await exit();
			assertEquals(await json_encode([]), '[]');
			await exit();

			let error;
			try
			{	await php_eval('exit(100);');
			}
			catch (e)
			{	if (e instanceof InterpreterExitError)
				{	error = e;
				}
			}
			assertEquals(error?.code, settings.php_fpm.listen ? 0 : 100);
		}
		php.close_idle();
	}
);

Deno.test
(	'Global',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	assertEquals(await g.FAKE_CONSTANT, undefined);
			assertEquals(await g.defined('FAKE_CONSTANT'), false);
			await g.define('FAKE_CONSTANT', 'hello');
			assertEquals(await g.FAKE_CONSTANT, 'hello');
			assertEquals(await g.defined('FAKE_CONSTANT'), true);

			assertEquals(await g.$fake_var, undefined);
			g.$fake_var = 'hello';
			assertEquals(await g.$fake_var, 'hello');

			g.$_SERVER['hello']['world'] = true;
			assertEquals(await g.$_SERVER['hello']['world'], true);
			assertEquals(await g.$_SERVER['hello'], {world: true});
			if (!settings.php_fpm.listen)
			{	assert(await g.$_SERVER['argc'] > 0);
			}

			delete g.$_SERVER['hello'];
			assertEquals(await g.$_SERVER['hello'], undefined);
			if (!settings.php_fpm.listen)
			{	assert(await g.$_SERVER['argc'] > 0);
			}

			g.$var.a = 10;
			assertEquals(await g.$var.a, 10);

			let v = await g.$var.this;
			assertEquals(await v.a, 10);
			assertEquals(await php.n_objects(), 1);
			delete v.this;
			assertEquals(await php.n_objects(), 0);

			await php.g.eval('global $я; $я = 10;');
			assertEquals(await g.$я, 10);

			let deno_obj: any = {a: {b: {c: 10}}};
			g.$var = deno_obj;
			assertEquals((await g.$var) === deno_obj, false);
			assertEquals(await g.$var, {a: {b: {c: 10}}});
			deno_obj = new DenoA({b: {c: 10}});
			g.$var = deno_obj;
			assertEquals((await g.$var) === deno_obj, true);
			delete g.$var.a.b.c;
			assertEquals(await g.$var, {a: {b: {}}});
			g.$var['a']['b'] = 'Hello all';
			await php.ready();
			assertEquals(deno_obj, {a: {b: 'Hello all'}});
			g.$_SERVER['hello']['world'] = deno_obj;
			assertEquals((await g.$_SERVER['hello']['world']) === deno_obj, true);

			await php_eval
			(	`	global $var;

					if (!($var instanceof DenoWorld) or !isset($var['a']['b']))
					{	throw new Exception("Invalid value");
					}

					$var = ['a' => ['b' => ['c' => 10]]];
				`
			);
			assertEquals(await g.$var, {a: {b: {c: 10}}});
			delete g.$var.a.b.c;
			assertEquals(await g.$var, {a: {b: {}}});
			g.$var['a'] = 'Hello all';
			assertEquals(await g.$var, {a: 'Hello all'});
			g.$var['a']['b'] = 'Hello all';
			assertEquals(await g.$var, {a: {b: 'Hello all'}});
			g.$var['a']['b'] = null;
			assertEquals(await g.$var, {a: {b: null}});

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Constants',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await g.eval
			(	`	namespace MainNs\\SecondaryNs;
					const VAL = 'The VAL';
				`
			);
			assertEquals(await g.MainNs.SecondaryNs.VAL, 'The VAL');

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'ob_start',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	g.ob_start();
			g.echo("A");
			g.echo("B");
			g.echo("C");
			assertEquals(await ob_get_clean(), 'ABC');

			await ob_start();
			await echo('A');
			await echo('B', 'C');
			assertEquals(await ob_get_clean(), 'ABC');

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Class static',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	class C
					{	public const TEN = 10;
						public static $var = 'hello';
						public static $var2;
						public static $var3 = ['prop' => 'value'];
						public static function get_eleven()
						{	return 11;
						}
					}
				`
			);

			assertEquals(await C.TEN, 10);
			assertEquals(await C.FAKE, undefined);

			assertEquals(await C.$var, 'hello');
			assertEquals(await C.$fake, undefined);

			C.$var = [await C.$var];
			assertEquals(await C.$var, ['hello']);

			C.$var = 1;
			C.$var = 2;
			C.$var = 3;
			assertEquals(await C.$var, 3);

			assertEquals(await C.$var3['prop'], 'value');

			assertEquals(await C.get_eleven(), 11);

			let deno_obj: any = {a: {b: {c: 10}}};
			C.$var2 = deno_obj;
			assertEquals((await C.$var2) === deno_obj, false);
			assertEquals(await C.$var2, {a: {b: {c: 10}}});
			deno_obj = new DenoA({b: {c: 10}});
			C.$var2 = deno_obj;
			assertEquals((await C.$var2) === deno_obj, true);
			delete C.$var2.a.b.c;
			assertEquals(await C.$var2, {a: {b: {}}});
			C.$var2['a']['b'] = 'Hello all';
			await php.ready();
			assertEquals(deno_obj, {a: {b: 'Hello all'}});
			let deno_obj_2 = new DenoA({b: {c: 11}});
			C.$var2['a']['b'] = deno_obj_2;
			assertEquals((await C.$var2['a']['b']) == deno_obj_2, true);

			await php_eval
			(	`	if (!(C::$var2 instanceof DenoWorld) or !isset(C::$var2['a']['b']))
					{	throw new Exception("Invalid value");
					}

					C::$var2 = ['a' => ['b' => ['c' => 10]]];
				`
			);
			assertEquals(await C.$var2, {a: {b: {c: 10}}});
			delete C.$var2.a.b.c;
			assertEquals(await C.$var2, {a: {b: {}}});
			C.$var2['a'] = 'Hello all';
			assertEquals(await C.$var2, {a: 'Hello all'});
			C.$var2['a']['b']['c'] = null;
			assertEquals(await C.$var2, {a: {b: {c: null}}});
			C.$var2 = null;
			assertEquals(await C.$var2, null);

			// invalid usage:
			let error = null;
			try
			{	+C.TEN; // invalid because the value not awaited
			}
			catch (e)
			{	error = e;
			}
			assert(error);

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Class static, namespace',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	namespace MainNs;

					class C
					{	public const TEN = 10;
						public static $var = 'hello';
						public static function get_eleven()
						{	return 11;
						}
					}
				`
			);

			assertEquals(await MainNs.C.TEN, 10);
			assertEquals(await MainNs.C.FAKE, undefined);

			assertEquals(await MainNs.C.$var, 'hello');
			assertEquals(await MainNs.C.$fake, undefined);

			MainNs.C.$var = [await MainNs.C.$var];
			assertEquals(await MainNs.C.$var, ['hello']);

			MainNs.C.$var = 1;
			MainNs.C.$var = 2;
			MainNs.C.$var = 3;
			assertEquals(await MainNs.C.$var, 3);

			assertEquals(await MainNs.C.get_eleven(), 11);

			// invalid usage:
			let error = null;
			try
			{	+MainNs.C.TEN; // invalid because the value not awaited
			}
			catch (e)
			{	error = e;
			}
			assert(error);

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Construct',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	class C
					{	public $arg_value;
						public $var = 10;
						public $for_c2;

						function __construct($arg)
						{	$this->arg_value = $arg->get_value();
							$this->for_c2 = ['key' => new C2];
							$this->for_c2_num = [new C2, new C2];
						}

						public function get_twice_var()
						{	return $this->var * 2;
						}

						public function __invoke($a='default a', $b='default b')
						{	return "$a/$b";
						}
					}

					class C2
					{	public function twice($n)
						{	return $n * 2;
						}
					}
				`
			);

			class DenoClass
			{	get_value()
				{	return 'the value';
				}
			}

			let obj = await new C(new DenoClass);

			assertEquals(await obj.arg_value, 'the value');

			assertEquals(await obj.var, 10);
			assertEquals(await obj.get_twice_var(), 20);

			obj.var = 12;
			assertEquals(await obj.var, 12);
			assertEquals(await obj.get_twice_var('hello'), 24);

			obj.a.b.cc = true;
			obj.a.bb = true;
			assertEquals(await obj.a, {b: {cc: true}, bb: true});
			assertEquals(await obj.a.b, {cc: true});

			obj.a.b.cc = [true];
			obj.a.bb = [true];
			assertEquals(await obj.a, {b: {cc: [true]}, bb: [true]});
			assertEquals(await obj.a.b, {cc: [true]});

			obj.a.b.cc = null;
			obj.a.bb = null;
			assertEquals(await obj.a, {b: {cc: null}, bb: null});
			assertEquals(await obj.a.b, {cc: null});

			assertEquals(await obj.for_c2.key.twice(3), 6);
			assertEquals(await obj.for_c2_num[0].twice(3), 6);
			assertEquals(await obj.for_c2_num[1].twice(4), 8);

			let obj_2 = await obj.for_c2['key'].this;
			assertEquals(await obj_2.key.twice(5), 10);

			obj.for_c2 = null;
			assertEquals(await obj_2.key.twice(6), 12);

			assertEquals(await obj('a', 3), 'a/3');
			assertEquals(await obj(), 'default a/default b');

			let deno_obj: any = {a: {b: {c: 12}}};
			obj.hello = deno_obj;
			assertEquals((await obj.hello) == deno_obj, false);
			assertEquals(await obj.hello, {a: {b: {c: 12}}});
			deno_obj = new DenoA({b: {c: 12}});
			obj.hello = deno_obj;
			assertEquals((await obj.hello) == deno_obj, true);
			obj.one.two = deno_obj;
			assertEquals((await obj.one.two) == deno_obj, true);

			delete obj.this;
			delete obj_2.this;
			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Construct namespace',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	namespace MainNs;

					class C
					{	public $var = 10;
						public function get_twice_var()
						{	return $this->var * 2;
						}
					}
				`
			);

			let c = await new MainNs.C;
			assertEquals(await c.var, 10);
			assertEquals(await c.get_twice_var(), 20);
			delete c.this;

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Function in namespace',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	namespace MainNs\\SubNs;

					function repeat($str, $times)
					{	return str_repeat($str, $times);
					}
				`
			);

			assertEquals(await g.MainNs.SubNs.repeat('a', 3), 'aaa');

			await exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Many interpreters',
	async () =>
	{	let int_1 = new PhpInterpreter;
		let int_2 = new PhpInterpreter;

		for (let _ of settings_iter(int_1.settings))
		{	for (let _ of settings_iter(int_2.settings))
			{	let pid_0 = await g.posix_getpid();
				let pid_1 = await int_1.g.posix_getpid();
				let pid_2 = await int_2.g.posix_getpid();

				assert(pid_0 > 0);
				assert(pid_1 > 0);
				assert(pid_2 > 0);
				assert(pid_0 != pid_1);
				assert(pid_1 != pid_2);

				if (!settings.php_fpm.listen)
				{	await g.exit();

					let pid_0_new = await g.posix_getpid();
					assert(pid_0_new != pid_0);
				}

				let pid_1_new = await int_1.g.posix_getpid();
				assert(pid_1_new == pid_1);

				if (!int_1.settings.php_fpm.listen)
				{	await int_1.g.exit();

					pid_1_new = await int_1.g.posix_getpid();
					assert(pid_1_new != pid_1);
				}

				await g.exit();
				await int_1.g.exit();
				await int_2.g.exit();
			}
		}
		php.close_idle();
	}
);

Deno.test
(	'Object returned from function',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	function get_ex($msg)
					{	return new Exception($msg);
					}
				`
			);

			let ex = await g.get_ex('The message').this;
			assertEquals(await ex.getMessage(), 'The message');
			delete ex.this;

			ex = await g.eval('return get_ex("The message");').this;
			assertEquals(await ex.getMessage(), 'The message');
			delete ex.this;

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Object from var',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	function init()
					{	global $e, $arr;

						$e = new Exception('The e');
						$arr[0] = new Exception('The e2');

						C::$e = $e;
						C::$arr = $arr;
					}

					class C
					{	static $e;
						static $arr;

						public $prop_e;
						public $prop_arr;

						function __construct()
						{	$this->prop_e = self::$e;
							$this->prop_arr = self::$arr;
						}
					}
				`
			);

			g.init();

			let ex = await g.$e.this;
			assertEquals(await ex.getMessage(), 'The e');
			delete ex.this;

			ex = await g.$arr[0].this;
			assertEquals(await ex.getMessage(), 'The e2');
			delete ex.this;

			ex = await C.$e.this;
			assertEquals(await ex.getMessage(), 'The e');
			delete ex.this;

			ex = await C.$arr[0].this;
			assertEquals(await ex.getMessage(), 'The e2');
			delete ex.this;

			let obj = await new C;
			ex = await obj.prop_e.this;
			assertEquals(await ex.getMessage(), 'The e');
			delete obj.this;
			delete ex.this;

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Unset',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	namespace MainNs\\SubNs;

					class C
					{	static $var = ['one' => 1, 'two' => ['three' => 3]];
						public $prop = ['one' => 1, 'two' => ['three' => 3]];
					}
				`
			);

			delete c.MainNs.SubNs.C.$var['two']['three'];
			assertEquals(await c.MainNs.SubNs.C.$var, {one: 1, two: {}});
			c.MainNs.SubNs.C.$var['two']['three'] = 3;
			assertEquals(await c.MainNs.SubNs.C.$var, {one: 1, two: {three: 3}});
			delete c.MainNs.SubNs.C.$var['two'];
			assertEquals(await c.MainNs.SubNs.C.$var, {one: 1});

			let obj = await new c.MainNs.SubNs.C;
			assertEquals(await obj.prop, {one: 1, two: {three: 3}});
			delete obj.prop['two']['three'];
			assertEquals(await obj.prop, {one: 1, two: {}});
			delete obj.prop['two'];
			assertEquals(await obj.prop, {one: 1});
			delete obj.prop;
			assertEquals(await obj.prop, undefined);
			delete obj.this;

			g.$tmp = undefined;
			assertEquals(await g.$tmp, null);
			g.$tmp = ['a', 'b'];
			assertEquals(await g.$tmp, ['a', 'b']);
			delete g.$tmp[1];
			assertEquals(await g.$tmp, ['a']);
			delete g.$tmp;
			assertEquals(await g.$tmp, undefined);

			let deno_obj: any = ['a', 'b', {value: 'c'}];
			g.$tmp = deno_obj;
			assertEquals((await g.$tmp) === deno_obj, false);
			assertEquals(await g.$tmp, ['a', 'b', {value: 'c'}]);
			deno_obj = new DenoArray('a', 'b', {value: 'c'});
			g.$tmp = deno_obj;
			assertEquals((await g.$tmp) === deno_obj, true);
			delete g.$tmp[2]['value'];
			assertEquals(await g.$tmp, ['a', 'b', {}]);

			await php_eval
			(	`	global $tmp;
					if (!($tmp instanceof DenoWorld) or $tmp[1]!='b')
					{	throw new Exception("Invalid value");
					}

					$tmp = ['a', 'b', ['value' => 'c']];
				`
			);
			assertEquals(await g.$tmp, ['a', 'b', {value: 'c'}]);
			delete g.$tmp[2]['value'];
			assertEquals(await g.$tmp, ['a', 'b', {}]);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Async',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	class C
					{	static int $v = 1;
						static int $v2 = 1;

						static function mul_add(int $mul)
						{	self::$v *= $mul;
							self::$v += self::$v2;
						}
					}
				`
			);

			C.$v2 = 3;
			C.mul_add(2); // 1*2 + 3 = 5
			C.$v2 = 2;
			C.mul_add(3); // = 5*3 + 2 = 17
			C.$v2 = 4;
			assertEquals(await C.$v, 17);
			assertEquals(await C.$v2, 4);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Async errors',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	class C
					{	static $n = 0;

						static function failure(string $msg)
						{	self::$n++;
							throw new Exception($msg);
						}
					}
				`
			);

			// async
			C.failure("Failure 1");
			C.failure("Failure 2");
			C.failure("Failure 3");
			let error = null;
			try
			{	console.log(await g.$argc);
			}
			catch (e)
			{	error = e;
			}
			assert(error?.message, 'Failure 1');
			assertEquals(await C.$n, 1);

			// async with sleep
			C.failure("Failure 1");
			C.failure("Failure 2");
			await sleep(0);
			C.failure("Failure 3");
			error = null;
			try
			{	console.log(await g.$argc);
			}
			catch (e)
			{	error = e;
			}
			assert(error?.message, 'Failure 3');
			assertEquals(await C.$n, 3);

			// await 1
			error = null;
			try
			{	await C.failure("Second failure 1");
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Second failure 1');
			assertEquals(await C.$n, 4);

			// await 2
			error = null;
			try
			{	await C.failure("Second failure 2");
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Second failure 2');
			assertEquals(await C.$n, 5);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Async errors nested',
	async () =>
	{	async function step_1(php: PhpInterpreter)
		{	// async
			php.c.C.failure("Failure 1");
			php.c.C.failure("Failure 2");
			php.c.C.failure("Failure 3");
			let error = null;
			try
			{	console.log(await php.g.$argc);
			}
			catch (e)
			{	error = e;
			}
			assert(error?.message, 'Failure 1');
			assertEquals(await php.c.C.$n, 1);

			// async with sleep
			php.c.C.failure("Failure 1");
			php.c.C.failure("Failure 2");
			await sleep(0);
			php.c.C.failure("Failure 3");
			error = null;
			try
			{	console.log(await php.g.$argc);
			}
			catch (e)
			{	error = e;
			}
			assert(error?.message, 'Failure 3');
			assertEquals(await php.c.C.$n, 3);

			// await 1
			error = null;
			try
			{	await php.c.C.failure("Second failure 1");
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Second failure 1');
			assertEquals(await php.c.C.$n, 4);

			// await 2
			error = null;
			try
			{	await php.c.C.failure("Second failure 2");
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Second failure 2');
			assertEquals(await php.c.C.$n, 5);
		}

		for (let _ of settings_iter(settings))
		{	settings.onsymbol = name =>
			{	if (name == 'step_1')
				{	return step_1;
				}
			};

			await php_eval
			(	`	global $php;

					class C
					{	static $n = 0;

						static function failure(string $msg)
						{	self::$n++;
							throw new Exception($msg);
						}
					}

					DenoWorld::step_1($php);
				`
			);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Async nested',
	async () =>
	{	function step_1(php: PhpInterpreter, val: string)
		{	php.g.ob_start(); // no await
			for (let i=0; i<3; i++)
			{	php.g.echo(val);
			}
			return php.g.ob_get_clean();
		}

		for (let _ of settings_iter(settings))
		{	settings.onsymbol = name =>
			{	if (name == 'step_1')
				{	return step_1;
				}
			};

			await g.eval
			(	`	global $php, $res;

					$res = DenoWorld::step_1($php, 'a');
				`
			);
			assertEquals(await g.$res, 'aaa');

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Nested',
	async () =>
	{	async function step_1(php: PhpInterpreter, val: string)
		{	return await php.g.step_2(val + 'b');
		}
		async function step_3(php: PhpInterpreter, val: string)
		{	return await php.g.step_4(val + 'd');
		}

		for (let _ of settings_iter(settings))
		{	settings.onsymbol = name =>
			{	if (name == 'step_1')
				{	return step_1;
				}
				if (name == 'step_3')
				{	return step_3;
				}
			};

			await g.eval
			(	`	global $php, $res;

					function step_2($val)
					{	global $php;
						return DenoWorld::step_3($php, $val.'c');
					}
					function step_4($val)
					{	return $val.'e';
					}

					$res = DenoWorld::step_1($php, 'a');
				`
			);
			assertEquals(await g.$res, 'abcde');

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'n_deno_objects()',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	assertEquals(await php.n_deno_objects(), 2);
			await g.eval
			(	`	global $window, $var;
					$var = $window->Deno;
				`
			);
			assertEquals(await php.n_deno_objects(), 3);
			await g.eval
			(	`	global $window, $var2;
					$var2 = new DenoWorld\\Map;
				`
			);
			assertEquals(await php.n_deno_objects(), 4);
			await g.eval
			(	`	global $var, $var2;
					$var = null;
					$var2 = null;
				`
			);
			assertEquals(await php.n_deno_objects(), 2);
			await g.eval
			(	`	global $php, $window, $globalThis;
					$php = null;
					$window = null;
					$globalThis = null;
				`
			);
			assertEquals(await php.n_deno_objects(), 0);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Exception from Deno',
	async () =>
	{	function hello()
		{	throw new Error('Funds not sufficient');
		}

		for (let _ of settings_iter(settings))
		{	settings.onsymbol = name =>
			{	if (name == 'hello')
				{	return hello;
				}
			};

			await g.eval
			(	`	global $res, $done;

					try
					{	var_dump(DenoWorld::hello());
					}
					catch (Throwable $e)
					{	$res = $e;
					}
					$done = true;
				`
			);

			let res = await g.$res.this;
			assertEquals(await res.getMessage(), 'Funds not sufficient');
			assertEquals(await g.$done, true);
			delete res.this;

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Instance Of',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	namespace MainNs;

					class C
					{	static $inst;
					}

					function get_c()
					{	C::$inst = new C;
						return new C;
					}
				`
			);

			let obj = await new MainNs.C;
			assert(Object.prototype.toString.call(obj).indexOf('MainNs\\C') != -1);
			assertEquals(obj instanceof MainNs.C, true);
			assertEquals(obj instanceof c.Exception, false);
			assertEquals(obj instanceof g.intval, false);
			delete obj.this;

			obj = await g.MainNs.get_c().this;
			assert(Object.prototype.toString.call(obj).indexOf('MainNs\\C') != -1);
			assertEquals(obj instanceof MainNs.C, true);
			assertEquals(obj instanceof c.Exception, false);
			assertEquals(obj instanceof g.intval, false);
			delete obj.this;

			obj = await MainNs.C.$inst.this;
			assert(Object.prototype.toString.call(obj).indexOf('MainNs\\C') != -1);
			assertEquals(obj instanceof MainNs.C, true);
			assertEquals(obj instanceof c.Exception, false);
			assertEquals(obj instanceof g.intval, false);
			assertEquals(obj.var instanceof obj.var, false);
			delete obj.this;

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Assign object',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	await php_eval
			(	`	class C
					{	public $var = 10;
					}
				`
			);

			let obj = await new C;
			g.$tmp = obj;
			assertEquals(await g.$tmp['var'], 10);
			assertEquals(await g.$tmp, {var: 10});

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Iterators',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	let obj = await new c.ArrayObject(['a', 'b', 'c']);
			let arr = [];
			for await (let value of obj)
			{	arr.push(value);
			}
			assertEquals(arr, ['a', 'b', 'c']);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Push frame',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	for (let i=0; i<3; i++)
			{	assertEquals(await php.n_objects(), 0);
				php.push_frame();
				let obj = await new c.ArrayObject([]);
				assertEquals(await php.n_objects(), 1);

				php.push_frame();
				let obj2 = await new c.ArrayObject([]);
				assertEquals(await php.n_objects(), 2);

				php.push_frame();
				let obj3 = await new c.ArrayObject([]);
				assertEquals(await php.n_objects(), 3);

				php.pop_frame();
				assertEquals(await php.n_objects(), 2);
				delete obj3.this;
				assertEquals(await php.n_objects(), 2);

				delete obj2.this;
				assertEquals(await php.n_objects(), 1);
				php.pop_frame();
				assertEquals(await php.n_objects(), 1);

				php.pop_frame();
				assertEquals(await php.n_objects(), 0);

				let error;
				try
				{	php.pop_frame();
					await php.ready();
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.message, 'No frames to pop');
			}

			await g.exit();
			php.push_frame();
			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'Stdout',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	if (settings.php_fpm.listen=='' && settings.stdout=='piped')
			{	// no sleep
				let stdout = await php.get_stdout_reader();
				php.g.echo("*".repeat(256));
				php.drop_stdout_reader();
				let data = new TextDecoder().decode(await readAll(stdout));
				assertEquals(data, "*".repeat(256));

				// sleep
				stdout = await php.get_stdout_reader();
				php.g.echo("*".repeat(256));
				php.drop_stdout_reader();
				await sleep(0.2);
				data = new TextDecoder().decode(await readAll(stdout));
				assertEquals(data, "*".repeat(256));

				// exit + no sleep
				stdout = await php.get_stdout_reader();
				php.g.echo("*".repeat(256));
				let error;
				php.g.eval('exit;').catch((e: any) => {error = e});
				php.drop_stdout_reader();
				data = new TextDecoder().decode(await readAll(stdout));
				assertEquals(data, "*".repeat(256));
				let ok = g.substr('ok', 0, 100);
				await php.ready();
				assert(error !== undefined);
				assertEquals(await ok, 'ok');

				// await
				stdout = await php.get_stdout_reader();
				php.g.echo("*".repeat(256));
				php.drop_stdout_reader();
				data = new TextDecoder().decode(await readAll(stdout));
				assertEquals(data, "*".repeat(256));
				await g.phpversion();

				// exit + sleep
				stdout = await php.get_stdout_reader();
				php.g.echo("*".repeat(256));
				error = undefined;
				php.g.eval('exit;').catch((e: any) => {error = e});
				php.drop_stdout_reader();
				await sleep(0.2);
				data = new TextDecoder().decode(await readAll(stdout));
				assertEquals(data, "*".repeat(256));

				await g.exit();
			}
		}
		php.close_idle();
	}
);

Deno.test
(	'Binary data',
	async () =>
	{	let data = "\x00\x01\x02 \x7F\x80\x81 \xFD\xFE\xFF";
		for (let _ of settings_iter(settings))
		{	assertEquals(await g.substr(data, 0, 100), data);

			await g.exit();
		}
		php.close_idle();
	}
);

Deno.test
(	'PHP-FPM',
	async () =>
	{	for (let _ of settings_iter(settings))
		{	if (settings.php_fpm.listen == PHP_FPM_LISTEN)
			{	let promises = [];
				for (let i=0; i<10; i++)
				{	let php_i = new PhpInterpreter;
					promises[i] = Promise.resolve().then
					(	async () =>
						{	let len = await php_i.g.strlen('*'.repeat(i));
							await php_i.g.exit();
							return len;
						}
					);
				}
				let results: any = await Promise.all(promises);
				for (let i=0; i<10; i++)
				{	assertEquals(results[i], i);
				}
			}
		}
		php.close_idle();
	}
);

Deno.test
(	'Invalid',
	async () =>
	{	await php_eval
		(	`	class C
				{	public $var = 10;
				}
			`
		);
		let obj = await new C;

		let error;
		try
		{	await obj['inva prop'];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Property name must not contain spaces: $inva prop');

		error = undefined;
		try
		{	obj['inva prop'] = 10;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Property name must not contain spaces: inva prop');

		error = undefined;
		try
		{	await obj.var['inva func']();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Function name must not contain spaces: inva func');

		error = undefined;
		try
		{	await new obj.var();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot construct such object');

		error = undefined;
		try
		{	await php.g[''];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid object name');

		error = undefined;
		try
		{	await g['$inva var']['one'];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	await c['Inva class']['one'];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Class/namespace names must not contain spaces: Inva class');

		error = undefined;
		try
		{	await c.C.D['$inva var'];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: C\\D::$inva var');

		error = undefined;
		try
		{	await c.$var.val;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid object usage: $var');

		error = undefined;
		try
		{	await c['inva ns'].$var.val;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Class/namespace names must not contain spaces: inva ns');

		error = undefined;
		try
		{	await c.C['$inva var'].val;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	g.ns1.const1 = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot set this object: ns1');

		error = undefined;
		try
		{	g['$inva var'].a = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	c.$var.a = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot set this object: $var');

		error = undefined;
		try
		{	c.NsA['inca class'].$var = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot use such class name: NsA\\inca class');

		error = undefined;
		try
		{	c.NsA.C['$inva var'] = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	c.NsA.C.a = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot set this object: NsA.C.a');

		error = undefined;
		try
		{	c['inva ns'].$var.a = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot use such class name: inva ns');

		error = undefined;
		try
		{	c.C['$inva var'].a = 1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	delete g.const1.a;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot set this object: const1');

		error = undefined;
		try
		{	delete g['$inva var'].a;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	delete c.C.a;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot unset this object: C');

		error = undefined;
		try
		{	delete c['inva class'].$var.a;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot use such class name: inva class');

		error = undefined;
		try
		{	delete c.C['$inva var'].a;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	g.eval('1', '2');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid number of arguments to eval()');

		error = undefined;
		try
		{	g.include('1', '2');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid number of arguments to include()');

		error = undefined;
		try
		{	g.include_once('1', '2');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid number of arguments to include_once()');

		error = undefined;
		try
		{	g.require('1', '2');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid number of arguments to require()');

		error = undefined;
		try
		{	g.require_once('1', '2');
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid number of arguments to require_once()');

		error = undefined;
		try
		{	await c.C();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid class name usage: C');

		error = undefined;
		try
		{	for await (let v of c.C)
			{
			}
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Object is not iterable');

		error = undefined;
		try
		{	c[Symbol()] = 10;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot assign to this object');

		error = undefined;
		try
		{	c.C = 10;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot assign to class: C');

		error = undefined;
		try
		{	g.const1 = 10;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid global variable name: const1');

		error = undefined;
		try
		{	g['$inva var'] = 10;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		error = undefined;
		try
		{	delete g[Symbol()];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot delete this object');

		error = undefined;
		try
		{	delete c.C;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Cannot delete a class: C');

		error = undefined;
		try
		{	delete g.const1;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Invalid global variable name: const1');

		error = undefined;
		try
		{	delete g['$inva var'];
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Variable name must not contain spaces: $inva var');

		delete obj.this;
		await g.exit();
		php.close_idle();
	}
);

Deno.test
(	'Access Deno from PHP',
	async () =>
	{	settings.php_fpm.listen = '';
		settings.unix_socket_name = '';
		settings.stdout = 'inherit';

		await g.eval
		(	`	global $window, $val, $val2;
				$val = $window->parseInt('123 abc');
				$val2 = DenoWorld::parseInt('123 abc');
			`
		);
		assertEquals(await g.$val, 123);
		assertEquals(await g.$val2, 123);

		await g.eval
		(	`	global $window, $thousand, $thousand2;
				$thousand = $window->Math->pow(10, 3);
				$thousand2 = DenoWorld\\Math::pow(10, 3);
			`
		);
		assertEquals(await g.$thousand, 1000);
		assertEquals(await g.$thousand2, 1000);

		await g.eval
		(	`	global $window, $deno_pid, $deno_pid_2;
				$deno_pid = $window->Deno->pid;
				$deno_pid_2 = $window->eval('Deno.pid');
			`
		);
		assertEquals(await g.$deno_pid, Deno.pid);
		assertEquals(await g.$deno_pid_2, Deno.pid);

		await g.eval
		(	`	use DenoWorld\\Map;

				$m = new Map;
				$m->set('k1', 'v1');
				$m->set('k2', 'v2');
				$GLOBALS['m_size'] = $m->size;
				$GLOBALS['m_keys'] = $m->keys();
				$GLOBALS['m_keys_func'] = $m->keys->bind($m);
				$GLOBALS['m_arr'] = iterator_to_array($m);
				$GLOBALS['m_keys_arr'] = iterator_to_array($m->keys());
				$GLOBALS['count_m'] = count($m);
			`
		);
		assertEquals(await g.$m_size, 2);
		assertEquals([...await g.$m_keys], ['k1', 'k2']);
		let m_keys_func = await g.$m_keys_func;
		assertEquals([...m_keys_func()], ['k1', 'k2']);
		assertEquals(await g.$m_arr, [["k1", "v1"], ["k2", "v2"]]);
		assertEquals(await g.$m_keys_arr, ["k1", "k2"]);
		assertEquals(await g.$count_m, 2);

		await g.eval
		(	`	global $window, $val;
				$window->Ar = $window->Array;
				$a = new DenoWorld\\Ar('a', 'b');
				$a[] = 'c';
				$val = $a->indexOf('c');
			`
		);
		assertEquals(await g.$val, 2);

		await g.eval
		(	`	global $window, $a, $val;

				$window->eval("window.User = class User {name = 'Default name'; email = ''}");
				$a = new DenoWorld\\User;
				$a->phone = 111;
				$a['zip'] = 222;

				$val = $window->JSON->stringify($a);
			`
		);
		assertEquals(JSON.parse(await g.$val), {name: "Default name", email: "", phone: 111, zip: 222});
		await g.eval
		(	`	global $window, $a, $val, $val2, $phone_isset, $phone2_isset, $name_isset;
				unset($a['name']);

				$val = $window->JSON->stringify($a);

				$native = [];
				foreach ($a as $k => $v)
				{	$native[$k] = $v;
				}
				$val2 = json_encode($native);

				$phone_isset = isset($a['phone']);
				$phone2_isset = isset($a['phone2']);
				$name_isset = isset($a['name']);
			`
		);
		assertEquals(JSON.parse(await g.$val), {email: "", phone: 111, zip: 222});
		assertEquals(JSON.parse(await g.$val2), {email: "", phone: 111, zip: 222});
		assertEquals(await g.$phone_isset, true);
		assertEquals(await g.$phone2_isset, false);
		assertEquals(await g.$name_isset, false);

		let error;
		try
		{	await g.eval(`$GLOBALS['val'] = DenoWorld::eval('JUNK');`);
		}
		catch (e)
		{	error = e;
		}
		assert(error);

		let dispose_called = false;
		let dispose_called_2 = false;
		settings.onsymbol = name =>
		{	if (name == 'Scientific')
			{	class Scientific
				{	constructor(public n=0)
					{
					}

					twice()
					{	return this.n*2;
					}

					dispose()
					{	dispose_called = true;
						throw new Error('This exception in dispose() must be ignored');
					}
				}
				return Scientific;
			}
			else if (name == 'Scientific2')
			{	class Scientific2
				{	constructor(public n=0)
					{
					}

					quad()
					{	return this.n*4;
					}

					async dispose()
					{	dispose_called_2 = true;
						throw new Error('This exception in dispose() must be ignored');
					}

					toString()
					{	return 'This is Scientific2';
					}
				}
				return Scientific2;
			}
			else if (name == 'get_get_hello')
			{	function get_get_hello()
				{	function get_hello()
					{	return 'hello';
					}
					return get_hello;
				}
				return get_get_hello;
			}
		};
		await g.eval
		(	`	global $var, $var2, $var3, $var4, $var5;

				use DenoWorld\\Scientific, DenoWorld\\Scientific2;

				$obj = new Scientific(10);
				$var = $obj->twice();

				$obj = new Scientific2(10);
				$var2 = $obj->quad();

				$var3 = "$obj";

				$get_hello = DenoWorld::get_get_hello();
				$var4 = $get_hello();

				$var5 = $obj->__debugInfo();
			`
		);
		assertEquals(await g.$var, 20);
		assertEquals(dispose_called, true);
		assertEquals(await g.$var2, 40);
		assertEquals(dispose_called_2, true);
		assertEquals(await g.$var3, 'This is Scientific2');
		assertEquals(await g.$var4, 'hello');
		assertEquals(await g.$var5, {n: 10});

		g.eval
		(	`	global $c;

				class FirstClass
				{	static $stat, $stat2;
					public $prop, $prop2;
				}

				$c = new FirstClass;
			`
		);
		g.$parseInt = parseInt;
		g.$tmp2.a.b = parseInt;
		c.FirstClass.$stat = parseInt;
		c.FirstClass.$stat2.a.b = parseInt;
		g.$c.prop = parseInt;
		g.$c.prop2.a.b = parseInt;
		let obj = await new c.FirstClass;
		obj.prop = parseInt;
		obj.prop2.a.b = parseInt;
		g.$c2 = obj;
		g.eval
		(	`	global $c, $c2, $parseInt, $tmp2, $var, $var2, $var3, $var4, $var5, $var6, $var7, $var8;
				$var = $parseInt('234px');
				$var2 = $tmp2['a']['b']('345px');
				$f = FirstClass::$stat;
				$var3 = $f('456px');
				$f = FirstClass::$stat2['a']['b'];
				$var4 = $f('567px');
				$f = $c->prop;
				$var5 = $f('678px');
				$f = $c->prop2->a->b;
				$var6 = $f('789px');
				$f = $c2->prop;
				$var7 = $f('890px');
				$f = $c2->prop2['a']['b']; // TODO: maybe this must be prop2->a->b?
				$var8 = $f('901px');
			`
		);
		assertEquals(await g.$var, 234);
		assertEquals(await g.$var2, 345);
		assertEquals(await g.$var3, 456);
		assertEquals(await g.$var4, 567);
		assertEquals(await g.$var5, 678);
		assertEquals(await g.$var6, 789);
		assertEquals(await g.$var7, 890);
		assertEquals(await g.$var8, 901);

		g.eval
		(	`	global $err, $err2;

				try
				{	DenoWorld\\Math::fake();
				}
				catch (Throwable $e)
				{	$err = $e;
				}

				try
				{	DenoWorld\\Scientific::fake();
				}
				catch (Throwable $e)
				{	$err2 = $e;
				}
			`
		);
		assert(await g.$err);
		assert(await g.$err2);

		await g.exit();
		php.close_idle();
	}
);

Deno.test
(	'Variables from PHP',
	async () =>
	{	settings.php_fpm.listen = '';
		settings.unix_socket_name = '';
		settings.stdout = 'inherit';

		await g.eval
		(	`	class User
				{	public $name;

					function get_name()
					{	return $this->name;
					}
				}

				function get_user_name(User $user)
				{	return $user->get_name();
				}
			`
		);

		let user = await new c.User;
		user.name = 'Me';
		assertEquals(await g.get_user_name(user), 'Me');
		delete user.this;

		await g.exit();
		php.close_idle();
	}
);

Deno.test
(	'Include',
	async () =>
	{	let tmp_name = await Deno.makeTempFile();
		let i = 0;

		try
		{	for (let _ of settings_iter(settings))
			{	for (let func of ['include', 'include_once', 'require', 'require_once'])
				{	await Deno.writeTextFile(tmp_name, `<?php $GLOBALS['hello'] = 'all ${i}';`);
					await g[func](tmp_name);
					assertEquals(await g.$hello, `all ${i}`);
					await g.exit();

					i++;
				}
			}
		}
		finally
		{	await Deno.remove(tmp_name);
		}
		php.close_idle();
	}
);

Deno.test
(	'Proxy',
	async () =>
	{	settings.php_fpm.listen = '';
		settings.unix_socket_name = '';
		settings.stdout = 'inherit';

		let tmp_name = await Deno.makeTempFile({suffix: '.php'});

		try
		{	await Deno.writeTextFile(tmp_name, `<?php echo 'Hello all';`);

			let proxy = start_proxy
			(	{	frontend_listen: UNIX_SOCKET_NAME,
					backend_listen: PHP_FPM_LISTEN,
					max_conns: 128,
					keep_alive_timeout: 10000,
					keep_alive_max: Number.MAX_SAFE_INTEGER,
					unix_socket_name: '',
					max_name_length: 256,
					max_value_length: 4*1024, // "HTTP_COOKIE" param can have this length
					max_file_size: 10*1024*1024,
					async onrequest(php: PhpRequest)
					{	await php.proxy();
					}
				}
			);

			let response = await fcgi.fetch
			(	{	addr: proxy.addr,
					scriptFilename: tmp_name,
				},
				'http://localhost'
			);

			assertEquals(await response.text(), 'Hello all');

			proxy.stop();

			await fcgi.onEnd();
		}
		finally
		{	await Deno.remove(tmp_name);
		}
		php.close_idle();
	}
);

Deno.test
(	'Settings',
	async () =>
	{	let php = new PhpInterpreter
		(	{	php_cli_name: 'hello php_cli_name',
				php_fpm:
				{	listen: 'hello listen',
					keep_alive_timeout: 1234,
					keep_alive_max: 2345,
				}
			}
		);
		assertEquals(php.settings.php_cli_name, 'hello php_cli_name');
		assertEquals(php.settings.php_fpm.listen, 'hello listen');
		assertEquals(php.settings.php_fpm.keep_alive_timeout, 1234);
		assertEquals(php.settings.php_fpm.keep_alive_max, 2345);
	}
);

Deno.test
(	'json_encode',
	async () =>
	{	class DenoClass
		{	str = 'default str';
			arr = [1, 2, 'three'];
		}

		let res = await php.g.json_encode(new DenoClass);
		assertEquals(JSON.parse(res), {str: 'default str', arr: [1, 2, 'three']});

		php.g.eval
		(	`	function new_json_encode($value)
				{	return json_encode($value);
				}
			`
		);
		res = await php.g.new_json_encode(new DenoClass);
		assertEquals(JSON.parse(res), {str: 'default str', arr: [1, 2, 'three']});

		await php.g.exit();
	}
);

Deno.test
(	'Pass value PHP -> Deno -> PHP',
	async () =>
	{	await g.eval
		(	`	global $var, $var_arr;

				class C
				{	function get_value()
					{	return 'the value';
					}
				}

				$var = new C;
				$var_arr = [$var];
			`
		);

		g.$var2 = await g.$var.this;
		g.$var3 = [await g.$var.this];
		g.$var4 = await g.$var_arr[0].this;
		g.$var5 = [await g.$var_arr[0].this];

		await g.eval
		(	`	global $var2, $var3, $var4, $var5, $res2, $res3, $res4, $res5;

				$res2 = $var2->get_value();
				$res3 = $var3[0]->get_value();
				$res4 = $var4->get_value();
				$res5 = $var5[0]->get_value();
			`
		);

		assertEquals(await g.$res2, 'the value');
		assertEquals(await g.$res3, 'the value');
		assertEquals(await g.$res4, 'the value');
		assertEquals(await g.$res5, 'the value');

		await g.exit();
	}
);

Deno.test
(	'Pass value Deno -> PHP -> Deno',
	async () =>
	{	class FirstClass
		{	get_value()
			{	return 'the value';
			}
		}
		settings.onsymbol = name =>
		{	if (name == 'FirstClass')
			{	return FirstClass;
			}
		};

		let c = new FirstClass;

		g.$var1 = c;
		g.$var2 = [c];

		await g.eval
		(	`	global $var1, $var2, $res1, $res1_arr, $res2, $res2_arr;

				$res1 = $var1;
				$res1_arr = [$var1];

				$res2 = $var2[0];
				$res2_arr = [$var2[0]];

				function pass($arg)
				{	global $var;
					$var = $arg;
				}
			`
		);

		assertEquals((await g.$res1) === c, true);
		assertEquals((await g.$res1_arr)[0] === c, true);
		assertEquals((await g.$res1_arr[0]) === c, true);
		assertEquals((await g.$res2) === c, true);
		assertEquals((await g.$res2_arr)[0] === c, true);
		assertEquals((await g.$res2_arr[0]) === c, true);

		await g.pass(c);
		assertEquals((await g.$var) === c, true);
		await g.pass([c]);
		assertEquals((await g.$var)[0] === c, true);

		await g.exit();
	}
);

Deno.test
(	'Pass big data',
	async () =>
	{	let big_data = 'ф'.repeat(10*1024);

		g.$var = big_data;

		await g.eval
		(	`	global $var, $var2;

				$var2 = $var;
			`
		);

		assertEquals(await g.$var2, big_data);

		await g.exit();
	}
);
