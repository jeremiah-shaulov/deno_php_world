import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {sleep} from "https://deno.land/x/sleep/mod.ts";
import {g, c, PhpInterpreter} from './mod.ts';

const {eval: php_eval, ob_start, ob_get_clean, echo, json_encode, exit} = g;
const {MainNs, C} = c;

Deno.test
(	'exit',
	async () =>
	{	await exit();
		await exit();
		assertEquals(await json_encode([]), '[]');
		await exit();
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
	{	await ob_start();
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
					public function get_twice_var()
					{	return $this->var * 2;
					}
				}
			`
		);

		let c = await new C;
		assertEquals(await c.var, 10);
		assertEquals(await c.get_twice_var(), 20);
		delete c.this;

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
(	'Unset',
	async () =>
	{	await php_eval
		(	`	namespace MainNs\\SubNs;

				class C
				{	static $var = ['one' => 1, 'two' => ['three' => 3]];
				}
			`
		);

		delete c.MainNs.SubNs.C.$var['two']['three'];
		assertEquals(await c.MainNs.SubNs.C.$var, {one: 1, two: {}});
		c.MainNs.SubNs.C.$var['two']['three'] = 3;
		assertEquals(await c.MainNs.SubNs.C.$var, {one: 1, two: {three: 3}});
		delete c.MainNs.SubNs.C.$var['two'];
		assertEquals(await c.MainNs.SubNs.C.$var, {one: 1});

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
