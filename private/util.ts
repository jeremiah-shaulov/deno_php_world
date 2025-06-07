export async function exists(path: string|URL)
{	try
	{	await Deno.stat(path);
		return true;
	}
	catch (e)
	{	if (e && typeof(e)=='object' && ('code' in e) && e.code=='ENOENT')
		{	return false;
		}
		throw e;
	}
}
