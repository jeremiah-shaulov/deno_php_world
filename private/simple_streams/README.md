This library is reimplementation of built-in [ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream),
[WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream) and
[TransformStream](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream) classes that specializes on byte streams, that likes to reuse buffers,
doesn't like to [transfer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/transfer) buffers,
and has simplified API.

To make data stream you need to implement the following interface:

```ts
interface Source
{	/** Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
		bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
		encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
		use all of `p` as scratch space during the call. If some data is
		available but not `p.byteLength` bytes, `read()` conventionally resolves
		to what is available instead of waiting for more.

		When `read()` encounters end-of-file condition, it resolves to EOF
		(`null`).

		When `read()` encounters an error, it rejects with an error.

		Callers should always process the `n` > `0` bytes returned before
		considering the EOF (`null`). Doing so correctly handles I/O errors that
		happen after reading some bytes and also both of the allowed EOF
		behaviors.

		Implementations should not retain a reference to `p`.
	 **/
	read(p: Uint8Array): Promise<number|null>;
}
```
Maybe this resembles something familiar to you (spoiler: ex-`Deno.Reader`). Anyway if you implement this interface, you can create a readable stream from it.

```ts
const rdStream = new RdStream
(	{	async read(p)
		{	// ...
			// Load data to `p`
			// ...
			return p.byteLength; // or less
		}
	}
);
```

And the same with writable streams:

```ts
const wrStream = new WrStream
(	{	async write(p)
		{	// ...
			// Write `p` somewhere
			// ...
			return p.byteLength; // or less
		}
	}
);
```

## class RdStream

This class extends [ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream).

An instance can be created from `Source` definition (object that has `read()` method):

```ts
const rdStream = new RdStream
(	{	async read(p)
		{	// ...
			// Load data to `p`
			// ...
			return p.byteLength; // or less
		}
	}
);
```

For example `Deno.stdin` implements `read()`:

```ts
const rdStream = new RdStream(Deno.stdin);
```

Or it can be created as wrapper on existing `ReadableStream` object:

```ts
const rdStream = RdStream.from(Deno.stdin.readable);
```

Wrapping can be useful to benefit from `RdStream` features that `ReadableStream` doesn't have, like `text()` function:

```ts
const file = await Deno.open('/etc/passwd');
const rdStream = new RdStream(file); // `file` is `Deno.Reader`
console.log(await rdStream.text());
```

In many cases calling `pipeTo()` on `RdStream` that wraps `ReadableStream` is faster and/or consumes less memory, than calling `pipeTo()`
directly on `ReadableStream` (at least in Deno `1.37.2`), because `RdStream` uses efficient algorithms.

Creating `RdStream` from `read()` implementors (like `new RdStream(Deno.stdin)`) is preferrable (works faster) than creating from another streams (like `RdStream.from(Deno.stdin.readable)`).
However note that `Deno.stdin` also implements `close()`, so the file descriptor will be closed after reading to the end.
To prevent this, use:

```ts
const rdStream = new RdStream({read: p => Deno.stdin.read(p)});
```

`RdStream.from` also allows to create `RdStream` instances from iterable objects that yield `Uint8Array` items.

### Constructor:

```ts
constructor(source: Source);

type Source =
{	/**	If undefined or non-positive number, will use predefined default value (like 32 KiB) when allocating buffers.
	 **/
	autoAllocateChunkSize?: number;

	/**	When auto-allocating (reading in non-byob mode) will not call `read()` with buffers smaller than this.
		First i'll allocate `autoAllocateChunkSize` bytes, and if `read()` callback fills in only a small part of them
		(so there're >= `autoAllocateMin` unused bytes in the buffer), i'll reuse that part of the buffer in next `read()` calls.
	 **/
	autoAllocateMin?: number;

	/**	This callback is called immediately during `RdStream` object creation.
		When it's promise resolves, i start to call `read()` to pull data as response to `reader.read()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `cancel(reason)` or `catch(error)` is called.
		- `close()` is called if `read()` returned EOF (`0` or `null`).
		- `cancel()` if caller called `rdStream.cancel(reason)` or `reader.cancel(reason)`.
		- `catch()` if `read()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	/**	This method is called to pull data from input source to a Uint8Array object provied to it.
		The object provided is never empty.
		The function is expected to load available data to the view, and to return number of bytes loaded.
		On EOF it's expected to return `0` or `null`.
	 **/
	read(view: Uint8Array): number | null | PromiseLike<number|null>;

	/**	This method is called when {@link Source.read} returns `0` or `null` that indicate EOF.
		After that, no more callbacks are called.
		If you use `Deno.Reader & Deno.Closer` as source, that source will be closed when read to the end without error.
	 **/
	close?(): void | PromiseLike<void>;

	/**	Is called as response to `rdStream.cancel()` or `reader.cancel()`.
		After that, no more callbacks are called.
	 **/
	cancel?(reason: Any): void | PromiseLike<void>;

	/**	Is called when `read()` or `start()` thrown exception or returned a rejected promise.
		After that, no more callbacks are called.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};
```

In the Source `read()` is mandatory method. To indicate EOF it can return `0` or `null`.
It can return result asynchronously (`Promise` object) or synchronously (number or null result).

### Properties:

- **locked**

```ts
readonly locked: boolean;
```

When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after that call the stream becomes locked.
Future calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).

Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get reader, and release it later).

### Methods:

- **getReader**

```ts
getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
```
Returns object that allows to read data from the stream.
The stream becomes locked till this reader is released by calling `reader.releaseLock()`.

If the stream is already locked, this method throws error.

- **getReaderWhenReady**

```ts
getReaderWhenReady(options?: {mode?: undefined}): Promise<ReadableStreamDefaultReader<Uint8Array>>;
getReaderWhenReady(options: {mode: 'byob'}): Promise<ReadableStreamBYOBReader>;
```
Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).

If you actually don't need the reader, but just want to catch the moment when the stream unlocks, you can do:

```ts
(await rdStream.getReaderWhenReady()).releaseLock();
// here you can immediately (without awaiting any promises) call `pipeTo()`, or something else
```

- **cancel**

```ts
cancel(reason?: any): Promise<void>;
```
Interrupt current reading operation (reject the promise that `reader.read()` returned, if any),
and tell to discard further data in the stream.
This leads to calling `source.cancel(reason)`, even if current `source.read()` didn't finish.
`source.cancel()` must implement the actual behavior on how to discard further data,
and finalize the source, as no more callbacks will be called.

In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked.

- **[Symbol.asyncIterator], values**

```ts
[Symbol.asyncIterator](options?: {preventCancel?: boolean});
values(options?: {preventCancel?: boolean});
```
Allows you to iterate this stream yielding `Uint8Array` data chunks.

- **tee**

```ts
tee(options?: {requireParallelRead?: boolean}): [RdStream, RdStream];
```
Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.

If you'll read from one stream faster than from another, or will not read at all from one of them,
the default behavior is to buffer the data.

If `requireParallelRead` option is set, the buffering will be disabled,
and parent stream will suspend after each item, till it's read by both of the child streams.
In this case if you read and await from the first stream, without previously starting reading from the second,
this will cause a deadlock situation.

- **pipeTo**

```ts
pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions): Promise<void>;

type PipeOptions =
{	/**	Don't close `dest` when this readable stream reaches EOF.
	 **/
	preventClose?: boolean;

	/**	Don't abort `dest` when this readable stream enters error state.
	 **/
	preventAbort?: boolean;

	/**	Don't cancel this readable stream, if couldn't write to `dest`.
	 **/
	preventCancel?: boolean;

	/**	Allows to interrupt piping operation.
		The same effect can be reached by aborting the `dest` writable stream.
	 **/
	signal?: AbortSignal;
};
```
Pipe data from this stream to `dest` writable stream (that can be built-in `WritableStream<Uint8Array>` or `WrStream`).

If the data is piped to EOF without error, the source readable stream is closed as usual (`close()` callback is called on `Source`),
and the writable stream will be closed unless `preventClose` option is set.

If destination closes or enters error state, then `pipeTo()` throws exception.
But then `pipeTo()` can be called again to continue piping the rest of the stream to another destination (including previously buffered data).

- **pipeThrough**

```ts
pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
(	transform: Transform<W, R>,
	options?: PipeOptions
): R;

type Transform<W extends WritableStream<Uint8Array>, R extends ReadableStream<unknown>> =
{	readonly writable: W;
	readonly readable: R;

	/**	If this value is set to a positive integer, `rdStream.pipeThrough()` will use buffer of this size during piping.
		(By default it uses `autoAllocateChunkSize` that is set on parent `rdStream`).
		Practically this affects maximum chunk size in `transform(writer, chunk)` callback.
		If that callback returns `0` indicating that it wants more bytes, it will be called again with a larger chunk, till the chunk size reaches `overrideAutoAllocateChunkSize`.
		Then, if it still returns `0`, an error is thrown.
	 **/
	readonly overrideAutoAllocateChunkSize?: number;
};
```
Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.

- **read**

```ts
read(view: Uint8Array): Promise<number | null>;
```
Ex-`Deno.Reader` implementation for this object.
It gets a reader (locks the stream), reads, and then releases the reader (unlocks the stream).
It returns number of bytes loaded to the `view`, or `null` on EOF.
It returns `0` only if `view.byteLength == 0`.

- **uint8Array**

```ts
uint8Array(): Promise<Uint8Array>;
```
Reads the whole stream to memory.

- **text**

```ts
text(label?: string, options?: TextDecoderOptions): Promise<string>;
```
Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.

### Static methods:

- **from**

```ts
static from<R>(source: AsyncIterable<R> | Iterable<R | PromiseLike<R>>): ReadableStream<R> & RdStream
```
Converts iterable of `Uint8Array` to `RdStream`.
`ReadableStream<Uint8Array>` is also iterable of `Uint8Array`, so it can be converted,
and resulting `RdStream` will be wrapper on another readable stream.

If you have data source that implements both `ReadableStream<Uint8Array>` and `Deno.Reader`, it's more efficient to create wrapper from `Deno.Reader`
by calling `RdStream` constructor.

```ts
// Create from `Deno.Reader`. This is preferred.
const file1 = await Deno.open('/etc/passwd');
const rdStream1 = new RdStream(file1); // `file1` is `Deno.Reader`
console.log(await rdStream1.text());

// Create from `ReadableStream<Uint8Array>`.
const file2 = await Deno.open('/etc/passwd');
const rdStream2 = RdStream.from(file2.readable); // `file2.readable` is `ReadableStream<Uint8Array>`
console.log(await rdStream2.text());
```

## class WrStream

This class extends [WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream).

### Constructor:

```ts
constructor(sink: Sink);

type Sink =
{	/**	This callback is called immediately during `WrStream` object creation.
		When it's promise resolves, i start to call `write()` as response to `writer.write()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `abort(reason)` or `catch(error)` is called.
		- `close()` if caller called `writer.close()` to terminate the stream.
		- `abort()` if caller called `wrStream.abort(reason)` or `writer.abort(reason)`.
		- `catch()` if `write()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	/**	WrStream calls this callback to ask it to write a chunk of data to the destination that it's managing.
	 **/
	write(chunk: Uint8Array): number | PromiseLike<number>;

	/**	This method is called as response to `writer.close()`.
		After that, no more callbacks are called.
	 **/
	close?(): void | PromiseLike<void>;

	/**	This method is called as response to `wrStream.abort(reason)` or `writer.abort(reason)`.
		After that, no more callbacks are called.
	 **/
	abort?(reason: Any): void | PromiseLike<void>;

	/**	This method is called when {@link Sink.write} thrown exception or returned a rejected promise.
		After that, no more callbacks are called.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};
```

In the Sink `write()` is mandatory method.
It can return result asynchronously (`Promise` object) or synchronously (number result).

### Properties:

- **locked**

```ts
readonly locked: boolean;
```

When somebody wants to start writing to this stream, he calls `wrStream.getWriter()`, and after that call the stream becomes locked.
Future calls to `wrStream.getWriter()` will throw error till the writer is released (`writer.releaseLock()`).

Other operations that write to the stream (like `wrStream.writeAll()`) also lock it (internally they get writer, and release it later).

### Methods:

- **getWriter**

```ts
getWriter(): WritableStreamDefaultWriter<Uint8Array>;
```
Returns object that allows to write data to the stream.
The stream becomes locked till this writer is released by calling `writer.releaseLock()`.

If the stream is already locked, this method throws error.

- **getWriterWhenReady**

Like `wrStream.getWriter()`, but waits for the stream to become unlocked before returning the writer (and so locking it again).

If you actually don't need the writer, but just want to catch the moment when the stream unlocks, you can do:

```ts
(await wrStream.getWriterWhenReady()).releaseLock();
// here you can immediately (without awaiting any promises) call `writeAll()`, or something else
```

- **abort**

```ts
abort(reason?: Any): Promise<void>;
```

