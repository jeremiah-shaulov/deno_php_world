const DEFAULT_BUFFER_SIZE = 16*1024;
const READ_IF_HAVE_SIZE = 1*1024;

export async function exists(path: string|URL)
{	try
	{	await Deno.stat(path);
		return true;
	}
	catch (e)
	{	if (e.code == 'ENOENT')
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

/**	Write all the bytes from the provided buffer to the writer.
 **/
export async function writeAll(writer: Deno.Writer, buffer: Uint8Array)
{	while (buffer.length > 0)
	{	const n_written = await writer.write(buffer);
		buffer = buffer.subarray(n_written);
	}
}

/**	Read the whole stream from reader, till EOF, and return it as `Uint8Array` buffer.
 **/
export async function readAll(reader: Deno.Reader)
{	let buffer = new Uint8Array(READ_IF_HAVE_SIZE);
	let pos = 0;
	while (true)
	{	const n_read = await reader.read(buffer.subarray(pos));
		if (n_read == null)
		{	return buffer.subarray(0, pos);
		}
		else
		{	pos += n_read;
			if (buffer.length-pos < READ_IF_HAVE_SIZE)
			{	// realloc
				const tmp = new Uint8Array(buffer.length * 2);
				tmp.set(buffer);
				buffer = tmp;
			}
		}
	}
}

/**	Copies from `source` to `dest` until either EOF (`null`) is read from `source` or an error occurs.
	It resolves to the number of bytes copied or rejects with the first error encountered while copying.
 **/
export async function copy(source: Deno.Reader, dest: Deno.Writer, options?: {bufSize?: number})
{	const buffer = new Uint8Array(options?.bufSize ?? DEFAULT_BUFFER_SIZE);
	const half_buffer_size = Math.ceil(buffer.length / 2);
	let read_pos = 0;
	let read_pos_2 = 0;
	let write_pos = 0;
	let n_bytes_copied = 0;
	let is_eof = false;
	let read_promise: Promise<number|null> | undefined;
	let write_promise: Promise<number> | undefined;
	while (true)
	{	// Start (or continue) reading and/or writing
		read_promise ??=
		(	is_eof ?
				undefined : // Don't read if EOF
			read_pos<=half_buffer_size ? // Read if there's at least a half buffer free after the `read_pos`
				source.read
				(	read_pos==0 ? buffer.subarray(0, half_buffer_size) : // Don't try to read the full buffer, only it's half. The buffer is big enough (twice common size). This increases the chance that reading and writing will happen in parallel
					buffer.subarray(read_pos)
				) :
			write_pos-read_pos_2>=half_buffer_size ? // Read if there's at least a half buffer free on the left side of the already written position
				source.read(buffer.subarray(read_pos_2, write_pos)) :
				undefined
		);
		write_promise ??= // Write if there's something already read in the buffer
		(	read_pos>0 ?
				dest.write(buffer.subarray(write_pos, read_pos)).then(size => -size - 1) :
				undefined
		);
		// Await for the most fast promise
		let size = await (!write_promise ? read_promise : !read_promise ? write_promise : Promise.race([read_promise, write_promise]));
		// Now we have either read or written something
		if (size == null)
		{	// Read EOF
			read_promise = undefined;
			if (!write_promise)
			{	break;
			}
			is_eof = true;
		}
		else if (size >= 0)
		{	// Read a chunk
			read_promise = undefined;
			if (read_pos <= half_buffer_size)
			{	// Read from `read_pos` to `read_pos + size`
				read_pos += size;
			}
			else
			{	// Read from `read_pos_2` to `read_pos_2 + size`
				read_pos_2 += size;
			}
		}
		else
		{	// Written
			size = -size - 1;
			write_promise = undefined;
			write_pos += size;
			n_bytes_copied += size;
			if (read_pos==write_pos && !read_promise)
			{	read_pos = read_pos_2;
				read_pos_2 = 0;
				write_pos = 0;
				if (is_eof && read_pos==0)
				{	break;
				}
			}
		}
	}
	return n_bytes_copied;
}

export async function* iterateReader(reader: Deno.Reader, options?: {bufSize?: number})
{	const buffer = new Uint8Array(options?.bufSize ?? DEFAULT_BUFFER_SIZE);
	while (true)
	{	const n_read = await reader.read(buffer);
		if (n_read == null)
		{	break;
		}
		yield buffer.slice(0, n_read);
	}
}
