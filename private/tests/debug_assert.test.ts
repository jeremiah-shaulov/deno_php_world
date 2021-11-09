import {ASSERTIONS_ENABLED, debug_assert} from '../debug_assert.ts';
import {assert} from "../deps.ts";

Deno.test
(	'debug_assert',
	async () =>
	{	debug_assert(true);
		let error;
		try
		{	debug_assert(false);
		}
		catch (e)
		{	error = e;
		}
		assert(!ASSERTIONS_ENABLED || error);
	}
);
