import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {g, f, c, PhpInterpreter} from './mod.ts';

const {eval: php_eval, ob_start, ob_get_clean, echo, json_encode, exit} = f;
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
		assertEquals(await f.defined('FAKE_CONSTANT'), false);
		await f.define('FAKE_CONSTANT', 'hello');
		assertEquals(await g.FAKE_CONSTANT, 'hello');
		assertEquals(await f.defined('FAKE_CONSTANT'), true);

		assertEquals(await g.$fake_var, undefined);
		g.$fake_var = 'hello';
		assertEquals(await g.$fake_var, 'hello');
		await exit();
	}
);

Deno.test
(	'ob_start',
	async () =>
	{	await ob_start();
		await echo('A');
		await echo('B');
		assertEquals(await ob_get_clean(), 'AB');
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
(	'Many interpreters',
	async () =>
	{	let int_1 = new PhpInterpreter;
		let int_2 = new PhpInterpreter;

		let pid_0 = await f.posix_getpid();
		let pid_1 = await int_1.f.posix_getpid();
		let pid_2 = await int_2.f.posix_getpid();

		assert(pid_0 > 0);
		assert(pid_1 > 0);
		assert(pid_2 > 0);
		assert(pid_0 != pid_1);
		assert(pid_1 != pid_2);

		await f.exit();
		await int_1.f.exit();
		await int_2.f.exit();
	}
);
