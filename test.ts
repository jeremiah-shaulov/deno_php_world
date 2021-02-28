import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {sleep} from "https://deno.land/x/sleep/mod.ts";
import {g, c, php, settings, PhpInterpreter, InterpreterExitError} from './mod.ts';

const {eval: php_eval, ob_start, ob_get_clean, echo, json_encode, exit} = g;
const {MainNs, C} = c;

Deno.test
(	'Exit',
	async () =>
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
		assertEquals(error?.code, 100);
	}
);

Deno.test
(	'Global',
	async () =>
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
		assert(await g.$_SERVER['argc'] > 0);

		delete g.$_SERVER['hello'];
		assertEquals(await g.$_SERVER['hello'], undefined);
		assert(await g.$_SERVER['argc'] > 0);

		await exit();
	}
);

Deno.test
(	'ob_start',
	async () =>
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
);

Deno.test
(	'Class static',
	async () =>
	{	await php_eval
		(	`	class C
				{	public const TEN = 10;
					public static $var = 'hello';
					public static $var2;
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

		assertEquals(await C.get_eleven(), 11);

		C.$var2 = {a: {b: {c: 10}}};
		assertEquals(await C.$var2, {a: {b: {c: 10}}});
		assertEquals(await C.$var2['a'], {b: {c: 10}});
		assertEquals(await C.$var2['a']['b']['c'], 10);

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
);

Deno.test
(	'Class static, namespace',
	async () =>
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
);

Deno.test
(	'Construct',
	async () =>
	{	await php_eval
		(	`	class C
				{	public $var = 10;
					public $for_c2;

					function __construct()
					{	$this->for_c2 = ['key' => new C2];
					}

					public function get_twice_var()
					{	return $this->var * 2;
					}
				}

				class C2
				{	public function twice($n)
					{	return $n * 2;
					}
				}
			`
		);

		let obj = await new C;

		assertEquals(await obj.var, 10);
		assertEquals(await obj.get_twice_var(), 20);

		obj.var = 12;
		assertEquals(await obj.var, 12);
		assertEquals(await obj.get_twice_var(), 24);

		obj.a.b.cc = [true];
		obj.a.bb = [true];
		assertEquals(await obj.a, {b: {cc: [true]}, bb: [true]});
		assertEquals(await obj.a.b, {cc: [true]});

		assertEquals(await obj.for_c2.key.twice(3), 6);

		delete obj.this;
		await exit();
	}
);

Deno.test
(	'Construct namespace',
	async () =>
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
);

Deno.test
(	'Function in namespace',
	async () =>
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
);

Deno.test
(	'Many interpreters',
	async () =>
	{	let int_1 = new PhpInterpreter;
		let int_2 = new PhpInterpreter;

		let pid_0 = await g.posix_getpid();
		let pid_1 = await int_1.g.posix_getpid();
		let pid_2 = await int_2.g.posix_getpid();

		assert(pid_0 > 0);
		assert(pid_1 > 0);
		assert(pid_2 > 0);
		assert(pid_0 != pid_1);
		assert(pid_1 != pid_2);

		await g.exit();

		let pid_0_new = await g.posix_getpid();
		assert(pid_0_new != pid_0);

		let pid_1_new = await int_1.g.posix_getpid();
		assert(pid_1_new == pid_1);

		await int_1.g.exit();

		pid_1_new = await int_1.g.posix_getpid();
		assert(pid_1_new != pid_1);

		await g.exit();
		await int_1.g.exit();
		await int_2.g.exit();
	}
);

Deno.test
(	'Object returned from function',
	async () =>
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
);

Deno.test
(	'Object from var',
	async () =>
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
);

Deno.test
(	'Unset',
	async () =>
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

		g.$tmp = ['a', 'b', {value: 'c'}];
		assertEquals(await g.$tmp, ['a', 'b', {value: 'c'}]);
		delete g.$tmp[2]['value'];
		assertEquals(await g.$tmp, ['a', 'b', {}]);

		await g.exit();
	}
);

Deno.test
(	'Async',
	async () =>
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
);

Deno.test
(	'Async errors',
	async () =>
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
);

Deno.test
(	'Instance Of',
	async () =>
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
		delete obj.this;

		obj = await g.MainNs.get_c().this;
		assert(Object.prototype.toString.call(obj).indexOf('MainNs\\C') != -1);
		assertEquals(obj instanceof MainNs.C, true);
		delete obj.this;

		obj = await MainNs.C.$inst.this;
		assert(Object.prototype.toString.call(obj).indexOf('MainNs\\C') != -1);
		assertEquals(obj instanceof MainNs.C, true);
		delete obj.this;

		await g.exit();
	}
);

Deno.test
(	'Assign object',
	async () =>
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
);

Deno.test
(	'Iterators',
	async () =>
	{	let obj = await new c.ArrayObject(['a', 'b', 'c']);
		/*let arr = [];
		for await (let value of obj)
		{	arr.push(value);
		}
		assertEquals(arr, ['a', 'b', 'c']);*/

		await g.exit();
	}
);

Deno.test
(	'Push frame',
	async () =>
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
		}

		await g.exit();
	}
);

Deno.test
(	'Stdout',
	async () =>
	{	settings.stdout = 'piped';

		// no sleep
		let stdout = await php.get_stdout_reader();
		php.g.echo("*".repeat(256));
		php.drop_stdout_reader();
		let data = new TextDecoder().decode(await Deno.readAll(stdout));
		assertEquals(data, "*".repeat(256));

		// sleep
		stdout = await php.get_stdout_reader();
		php.g.echo("*".repeat(256));
		php.drop_stdout_reader();
		await sleep(0.2);
		data = new TextDecoder().decode(await Deno.readAll(stdout));
		assertEquals(data, "*".repeat(256));

		// exit + no sleep
		stdout = await php.get_stdout_reader();
		php.g.echo("*".repeat(256));
		let error;
		php.g.eval('exit;').catch((e: any) => {error = e});
		php.drop_stdout_reader();
		data = new TextDecoder().decode(await Deno.readAll(stdout));
		assertEquals(data, "*".repeat(256));
		let ok = g.substr('ok', 0, 100);
		await php.ready();
		assert(error !== undefined);
		assertEquals(await ok, 'ok');

		// await
		stdout = await php.get_stdout_reader();
		php.g.echo("*".repeat(256));
		php.drop_stdout_reader();
		data = new TextDecoder().decode(await Deno.readAll(stdout));
		assertEquals(data, "*".repeat(256));
		await g.phpversion();

		// exit + sleep
		stdout = await php.get_stdout_reader();
		php.g.echo("*".repeat(256));
		error = undefined;
		php.g.eval('exit;').catch((e: any) => {error = e});
		php.drop_stdout_reader();
		await sleep(0.2);
		data = new TextDecoder().decode(await Deno.readAll(stdout));
		assertEquals(data, "*".repeat(256));

		await g.exit();
	}
);

Deno.test
(	'Binary data',
	async () =>
	{	assertEquals(await g.substr("\x00\x01\x02 \x7F\x80\x81 \xFD\xFE\xFF", 0, 100), "\x00\x01\x02 \x7F\x80\x81 \xFD\xFE\xFF");

		await g.exit();
	}
);
