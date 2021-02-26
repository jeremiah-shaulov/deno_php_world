export class ReaderMux
{	private is_eof = false;
	private buffer: Uint8Array;
	private buffer_len = 0;

	constructor(private reader: Deno.Reader, private end_mark: Uint8Array)
	{	this.buffer = new Uint8Array(end_mark.length);
	}

	async read(out_buffer: Uint8Array)
	{	// 1. Read
		if (this.is_eof)
		{	return null;
		}
		let n_read = await this.reader.read(out_buffer);
		if (n_read == null)
		{	this.is_eof = true;
			return null;
		}
		// 2. Keep last buffer.length read bytes in this.buffer
		if (n_read >= this.buffer.length)
		{	this.buffer.set(out_buffer.subarray(n_read-this.buffer.length, n_read));
			this.buffer_len = this.buffer.length;
		}
		else
		{	let exceeding_bytes = this.buffer_len+n_read - this.buffer.length;
			if (exceeding_bytes < 0)
			{	this.buffer.set(out_buffer, this.buffer_len);
				this.buffer_len += n_read;
				return n_read;
			}
			// cut exceeding bytes (i need only buffer.length)
			this.buffer.copyWithin(0, exceeding_bytes, this.buffer_len);
			this.buffer_len -= exceeding_bytes;
			// append new bytes
			this.buffer.set(out_buffer, this.buffer_len);
			this.buffer_len = this.buffer.length;
		}
		// 3. If last read bytes match end_mark, interrupt the stream
		if (this.buffer_len==this.buffer.length && this.buffer.every((value, index) => value === this.end_mark[index]))
		{	this.is_eof = true;
			n_read -= this.buffer.length;
			if (n_read == 0)
			{	return null;
			}
		}
		// 4. Done
		return n_read;
	}
}
