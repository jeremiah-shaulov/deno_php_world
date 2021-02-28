export class ReaderMux
{	private is_eof = false;
	private buffer: Uint8Array;
	private buffer_len = 0;
	private task = Promise.resolve();

	public is_reading = false;

	constructor(private reader: Deno.Reader, public end_mark: Uint8Array)
	{	this.buffer = new Uint8Array(end_mark.length);
	}

	async get_reader(): Promise<Deno.Reader>
	{	let that = this;
		let {buffer} = this;

		await this.task; // let previous reader to complete
		let task_done: () => void;
		this.task = new Promise(y => {task_done = y});
		this.is_eof = false;
		this.is_reading = true;

		async function read(out_buffer: Uint8Array)
		{	// 1. Read
			if (that.is_eof)
			{	return null;
			}
			let n_read = await that.reader.read(out_buffer);
			if (n_read == null)
			{	that.is_eof = true;
				that.is_reading = false;
				task_done();
				return null;
			}
			// 2. Keep last buffer.length read bytes in buffer
			if (n_read >= buffer.length)
			{	buffer.set(out_buffer.subarray(n_read-buffer.length, n_read));
				that.buffer_len = buffer.length;
			}
			else
			{	let exceeding_bytes = that.buffer_len+n_read - buffer.length;
				if (exceeding_bytes < 0)
				{	buffer.set(out_buffer.subarray(0, n_read), that.buffer_len);
					that.buffer_len += n_read;
					return n_read;
				}
				// cut exceeding bytes (i need only buffer.length)
				buffer.copyWithin(0, exceeding_bytes, that.buffer_len);
				that.buffer_len -= exceeding_bytes;
				// append new bytes
				buffer.set(out_buffer.subarray(0, n_read), that.buffer_len);
				that.buffer_len = buffer.length;
			}
			// 3. If last read bytes match end_mark, interrupt the stream
			if (that.buffer_len==buffer.length && buffer.every((value, index) => value === that.end_mark[index]))
			{	that.is_eof = true;
				n_read -= buffer.length;
				that.is_reading = false;
				task_done();
				if (n_read == 0)
				{	return null;
				}
			}
			// 4. Done
			return n_read;
		}

		return {read};
	}

	async set_writer(writer: Deno.Writer)
	{	Deno.copy(await this.get_reader(), writer);
	}

	async set_none()
	{	await this.task;
	}
}
