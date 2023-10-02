import {ReadableStreamOfBytes} from './readable_stream_of_bytes.ts';

const BUFFER_SIZE_DEFAUT = 8*1024;

export class ReaderMux
{	private busy = Promise.resolve();
	private free: VoidFunction | undefined;
	private after_end_mark: Uint8Array | undefined;
	private inner_reader: ReadableStreamBYOBReader | undefined;
	private is_eof = false;

	constructor(private inner_stream_promise: Promise<ReadableStream<Uint8Array> | null>, private end_mark: Uint8Array)
	{
	}

	async get_reader_or_readable(): Promise<Deno.Reader & {readable: ReadableStream<Uint8Array>}>
	{	// 1. Wait for previous `readable` to close
		let free: VoidFunction | undefined;
		while (true)
		{	free = this.free;
			await this.busy;
			if (this.free == free)
			{	break;
			}
		}

		// 2. Create new `reader_or_readable`
		const {inner_stream_promise, end_mark} = this;
		// deno-lint-ignore no-this-alias
		const that = this;
		let mark_bytes_matching = 0;
		let buffer: Uint8Array | undefined;
		let ongoing = Promise.resolve(null as number|null);
		this.busy = new Promise(y => free = y);
		this.free = free;

		if (!this.inner_reader && !this.is_eof)
		{	const inner_stream = await inner_stream_promise;
			if (inner_stream)
			{	this.inner_reader = inner_stream.getReader({mode: 'byob'});
			}
			else
			{	this.is_eof = true;
			}
		}
		let {inner_reader} = this;

		/**	Read from `inner_stream_promise` to `buffer`.
			@return number of bytes read
		 **/
		async function inner_read(want_size: number)
		{	if (inner_reader && mark_bytes_matching<end_mark.length)
			{	const {after_end_mark} = that;
				if (after_end_mark)
				{	// Read from `after_end_mark`
					const n_to_mark = get_part_to_mark(after_end_mark); // reassigns `that.after_end_mark`
					if (n_to_mark > 0)
					{	const n_read = Math.min(n_to_mark, want_size);
						mark_bytes_matching = 0;
						that.after_end_mark = n_read>=after_end_mark.length ? undefined : after_end_mark.subarray(n_read);
						buffer = after_end_mark.slice(0, n_read);
						return n_read;
					}
					if (mark_bytes_matching >= end_mark.length)
					{	inner_reader = undefined;
						free?.();
						return null;
					}
				}
				// Read from `inner_reader`
				if (!buffer || buffer.length<want_size)
				{	buffer = new Uint8Array(want_size);
				}
				let use_buffer = buffer; // `use_buffer` == `buffer` (always); `use_buffer` is needed only for typescript to know that the buffer is not undefined
				while (true)
				{	const {value, done} = await inner_reader.read(new Uint8Array(use_buffer.buffer, 0, want_size));
					if (value?.byteLength)
					{	use_buffer = value;
						buffer = use_buffer;
						const n_to_mark = get_part_to_mark(use_buffer);
						if (n_to_mark > 0)
						{	return n_to_mark;
						}
						if (mark_bytes_matching >= end_mark.length)
						{	break;
						}
					}
					else if (done)
					{	that.is_eof = true;
						break;
					}
				}
			}
			inner_reader = undefined;
			free?.();
			return null;
		}

		function schedule_inner_read(want_size: number)
		{	const promise = ongoing.then(() => inner_read(want_size));
			ongoing = promise;
			return promise;
		}

		async function inner_discard()
		{	while (true)
			{	const n_read = await schedule_inner_read(BUFFER_SIZE_DEFAUT);
				if (n_read == null)
				{	break;
				}
			}
		}

		/**	Scan `data` to find the `mark` (whole, or partial at the end).
		 **/
		function get_part_to_mark(data: Uint8Array)
		{	// mark_bytes_matching contains how many starting `end_mark` bytes are already read
L:			for (let i=-mark_bytes_matching, i_end=data.length; i<i_end; i++)
			{	for (let j=0, k=i, k_end=Math.min(i+end_mark.length, i_end); k<k_end; j++, k++)
				{	if (end_mark[j] != (k>=0 ? data[k] : end_mark[end_mark.length + k]))
					{	continue L;
					}
				}
				// The mark is found (whole, or partial at the end)
				mark_bytes_matching = Math.min(i_end-i, end_mark.length);
				that.after_end_mark = i+mark_bytes_matching >= i_end ? undefined : data==that.after_end_mark ? data.subarray(i+mark_bytes_matching) : data.slice(i+mark_bytes_matching);
				return i;
			}
			mark_bytes_matching = 0;
			that.after_end_mark = undefined;
			return data.length;
		}

		const result =
		{	async read(read_buffer: Uint8Array)
			{	const n_read = await schedule_inner_read(read_buffer.byteLength);
				if (n_read != null)
				{	const chunk = buffer!.subarray(0, n_read);
					read_buffer.set(chunk);
				}
				return n_read;
			},

			get readable()
			{	return new ReadableStreamOfBytes
				(	{	type: 'bytes',
						autoAllocateChunkSize: BUFFER_SIZE_DEFAUT,

						async pull(controller)
						{	const view = controller.byobRequest.view;
							const n_read = await schedule_inner_read(view.byteLength);
							if (n_read != null)
							{	const chunk = buffer!.subarray(0, n_read);
								view.set(chunk);
								controller.byobRequest.respond(n_read);
							}
							else
							{	controller.close();
							}
						},

						cancel: inner_discard,
					}
				);
			},
		};

		return result;
	}

	async dispose()
	{	while (!this.is_eof)
		{	const reader_or_readable = await this.get_reader_or_readable();
			await reader_or_readable.readable.cancel();
		}
		this.inner_reader?.releaseLock();
		this.inner_reader = undefined;
	}
}
