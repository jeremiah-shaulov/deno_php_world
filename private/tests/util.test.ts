import {copy} from "../util.ts";
import {assert, assertEquals} from "../deps.ts";

function get_seq_reader(n_bytes: number, chunk_lens: number[], delays: number[]): Deno.Reader
{	let i = 0;
	let j = 0;
	const reader =
	{	async read(buffer: Uint8Array)
		{	await new Promise(y => setTimeout(y, delays[i % delays.length]));
			if (j == n_bytes)
			{	return null;
			}
			const chunk_len = Math.min(chunk_lens[i++ % chunk_lens.length], buffer.length);
			let k = 0;
			while (k<chunk_len && j<n_bytes)
			{	buffer[k++] = j++ & 0xFF;
			}
			return k;
		}
	};
	return reader;
}

function get_writer_to_buffer(out_buffer: Uint8Array, chunk_lens: number[], delays: number[]): Deno.Writer
{	let i = 0;
	let pos = 0;
	const writer =
	{	async write(buffer: Uint8Array)
		{	await new Promise(y => setTimeout(y, delays[i % delays.length]));
			const chunk_len = Math.min(chunk_lens[i++ % chunk_lens.length], buffer.length);
			if (pos+chunk_len > out_buffer.length)
			{	throw new Error('No more space in buffer');
			}
			out_buffer.set(buffer.subarray(0, chunk_len), pos);
			pos += chunk_len;
			return chunk_len;
		}
	};
	return writer;
}

function is_seq(buffer: Uint8Array)
{	for (let i=0; i<buffer.length; i++)
	{	if (buffer[i] != (i & 0xFF))
		{	throw new Error(`Invalid sequence at ${i} (out of ${buffer.length})`);
		}
	}
	return true;
}

Deno.test
(	'copy',
	async () =>
	{	{	const buffer = new Uint8Array(100_000);
			const n_written = await copy(get_seq_reader(buffer.length, [800], [3, 1, 2]), get_writer_to_buffer(buffer, [700], [1, 2, 3]));
			assertEquals(n_written, buffer.length);
			assert(is_seq(buffer));
		}

		{	const buffer = new Uint8Array(100_000);
			const n_written = await copy(get_seq_reader(buffer.length, [700], [3, 1, 2]), get_writer_to_buffer(buffer, [800], [1, 2, 3]));
			assertEquals(n_written, buffer.length);
			assert(is_seq(buffer));
		}

		{	const buffer = new Uint8Array(100_000);
			const n_written = await copy(get_seq_reader(buffer.length, [8*1024], [3, 1, 2]), get_writer_to_buffer(buffer, [123], [1, 2, 3]));
			assertEquals(n_written, buffer.length);
			assert(is_seq(buffer));
		}

		{	const buffer = new Uint8Array(100_000);
			const n_written = await copy(get_seq_reader(buffer.length, [123], [3, 1, 2]), get_writer_to_buffer(buffer, [8*1024], [1, 2, 3]));
			assertEquals(n_written, buffer.length);
			assert(is_seq(buffer));
		}

		{	const buffer = new Uint8Array(100_000);
			const n_written = await copy(get_seq_reader(buffer.length, [8*1024], [3, 1, 2]), get_writer_to_buffer(buffer, [8*1024], [1, 2, 3]));
			assertEquals(n_written, buffer.length);
			assert(is_seq(buffer));
		}
	}
);
