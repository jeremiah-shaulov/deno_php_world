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

export async function get_random_key(buffer: Uint8Array): Promise<string>
{	let fh;
	try
	{	fh = await Deno.open('/dev/urandom', {read: true});
	}
	catch
	{	// assume: OS without /dev/urandom feature
		return Math.random()+'';
	}
	try
	{	let pos = 0;
		while (pos < buffer.length)
		{	const n_read = await fh.read(buffer.subarray(pos));
			if (n_read == null)
			{	throw new Error(`Failed to read from /dev/urandom`);
			}
			pos += n_read;
		}
	}
	finally
	{	fh.close();
	}
	return btoa(String.fromCharCode(...buffer));
}

export function get_weak_random_bytes(buffer: Uint8Array)
{	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = Math.floor(Math.random()*256);
	}
	return buffer;
}
