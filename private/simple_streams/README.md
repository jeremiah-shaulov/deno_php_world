This library introduces 3 classes: `RdStream`, `WrStream` and `TrStream`, that can be used in place of
[ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)`<Uint8Array>`,
[WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream)`<Uint8Array>` and
[TransformStream](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream)`<Uint8Array, Uint8Array>`.

This library reimplements `ReadableStream`, `WritableStream` and `TransformStream` in the fashion that the author of this library likes.
The style of this library is to reuse buffers, and not to [transfer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/transfer) buffers.

This library requires to implement only a simple interface to create stream of bytes.
Here is such interface that any object can implement to provide to others a readable byte-stream:

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

Actually there are some more optional properties and methods in the `Source` interface (i mentioned only the mandatory one only to show you how cool is it).
See the full definition below.

Example of how you can implement it:

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

// now use `rdStream` as you would use an instance of ReadableStream<Uint8Array>
```

And the following interface is for writeable streams:

```ts
interface Sink
{	/** Writes `p.byteLength` bytes from `p` to the underlying data stream. It
		resolves to the number of bytes written from `p` (`0` <= `n` <=
		`p.byteLength`) or reject with the error encountered that caused the
		write to stop early. `write()` must reject with a non-null error if
		would resolve to `n` < `p.byteLength`. `write()` must not modify the
		slice data, even temporarily.

		Implementations should not retain a reference to `p`.
	 **/
	write(p: Uint8Array): Promise<number>;
}
```

Example:

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

// now use `wrStream` as you would use an instance of WritableStream<Uint8Array>
```

# Differences from ReadableStream, WritableStream and TransformStream

- No controllers concept.
- BYOB-agnostic. Data consumer can use BYOB or regular reading mode, and there's no need of handling these situations differently.
- No transferring buffers that you pass to `reader.read(buffer)`, so the buffers remain usable after the call.

Differences in API:

- `reader.cancel()` and `writer.abort()` work also on locked streams.
- `getReader()` and `getWriter()` have `getReaderWhenReady()` and `getWriterWhenReady()` counterparts, that wait for reader/writer to be unlocked.
- `values()`, `tee()`, `pipeTo()` and `pipeThrough()` are present in both `RdStream` and `Reader`.
- `pipeTo()` and `pipeThrough()` are restartable (`transform()` can close it's writer, and then the rest of the input stream can be piped to elsewhere).

# Exported classes and types

```ts
import {RdStream, Source} from 'mod.ts';
import {WrStream, Sink} from 'mod.ts';
import {TrStream, Transformer} from 'mod.ts';
```

- [RdStream](#class-rdstream)
- [WrStream](#class-wrstream)
- [TrStream](#class-trstream)

## class RdStream

This class extends [ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)`<Uint8Array>`.

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

Or it can be created as wrapper on existing `ReadableStream` object. Here is another way of creating `RdStream` that reads from stdin:

```ts
const rdStream = RdStream.from(Deno.stdin.readable);
```

Now `rdStream` and `Deno.stdin.readable` are the same by the means of `ReadableStream` (both have `getReader()`),
but `RdStream` also has features that `ReadableStream` doesn't have. For example `text()` function:

```ts
console.log(await rdStream.text());
```

Creating `RdStream` from `read()` implementors (like `new RdStream(Deno.stdin)`) is preferrable (because it works faster) than creating from another streams (like `RdStream.from(Deno.stdin.readable)`).
However note that `Deno.stdin` also implements `close()`, so the file descriptor will be closed after reading to the end.
To prevent this, use:

```ts
const rdStream = new RdStream({read: p => Deno.stdin.read(p)});
```

`RdStream.from()` also allows to create `RdStream` instances from iterable objects that yield `Uint8Array` items (see `RdStream.from()`).

### Constructor:

```ts
function RdStream.constructor(source: Source);

type Source =
{	/**	When auto-allocating (reading in non-byob mode) will pass to {@link Source.read} buffers of at most this size.
		If undefined or non-positive number, a predefined default value (like 32 KiB) is used.
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
		This callback is called as response to user request for data, and it's never called before such request.
	 **/
	read(view: Uint8Array): number | null | PromiseLike<number|null>;

	/**	This method is called when {@link Source.read} returns `0` or `null` that indicate EOF.
		After that, no more callbacks are called (except `catch()`).
		If you use `Deno.Reader & Deno.Closer` as source, that source will be closed when read to the end without error.
	 **/
	close?(): void | PromiseLike<void>;

	/**	Is called as response to `rdStream.cancel()` or `reader.cancel()`.
		After that, no more callbacks are called (except `catch()`).
	 **/
	cancel?(reason: Any): void | PromiseLike<void>;

	/**	Is called when `start()`, `read()`, `close()` or `cancel()` thrown exception or returned a rejected promise.
		After that, no more callbacks are called.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};
```

`RdStream` instances are constructed from `Source` objects, that have definition of how data stream is generated.

If there's `start()` method, it gets called immediately, even before the constructor returns, to let the stream generator to initialize itself.
If `start()` returned Promise, this Promise is awaited before calling `read()` for the first time.

The only mandatory `Source` method is `read()`. This method is called each time data is requested from the stream by consumer.
Calls to `read()` are sequential, and new call doesn't begin untill previous call is finished (it's promise is fulfilled).
When `read()` is called it must load bytes to provided buffer, and return number of bytes loaded.
To indicate EOF it can return either `0` or `null`.
It can return result asynchronously (`Promise` object) or synchronously (number or null result).

Stream consumer can read the stream in [regular or "BYOB" mode](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/getReader#mode).
In BYOB, the consumer provides it's own buffer, which is passed to `read()`.
This buffer can be of any non-zero size.
In regular mode a buffer of at least `autoAllocateMin` bytes is allocated (and passed to `read()`).
The maximum auto-allocated buffer size is `autoAllocateChunkSize`.

When `read()` returned EOF (`0` or `null`), `close()` gets called to finalize the stream generator.

If `read()` thrown exception, `catch()` is called instead of `close()`.
Also if `read()` successfully returned EOF, but then `close()` thrown exception, `catch()` is also called.

Stream consumer can decide to cancel the stream by calling `rdStream.cancel()` or `reader.cancel()`.
In this case `cancel()` callback gets called.
This is the only callback that can be called in the middle of `read()` work, when asynchronous `read()` didn't return, so it can tell `read()` to return earlier.
If `cancel()` thrown exception, `catch()` is called as the last action.

### Properties:

- **locked**

```ts
readonly RdStream.locked: boolean;
```

When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after that call the stream becomes locked.
Future calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).

Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get reader, and release it later).

### Methods:

- **getReader**

```ts
function RdStream.getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
function RdStream.getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
```
Returns object that allows to read data from the stream.
The stream becomes locked till this reader is released by calling `reader.releaseLock()` or `reader[Symbol.dispose]()`.

If the stream is already locked, this method throws error.

- **getReaderWhenReady**

```ts
function RdStream.getReaderWhenReady(options?: {mode?: undefined}): Promise<ReadableStreamDefaultReader<Uint8Array>>;
function RdStream.getReaderWhenReady(options: {mode: 'byob'}): Promise<ReadableStreamBYOBReader>;
```
Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).

- **cancel**

```ts
function RdStream.cancel(reason?: any): Promise<void>;
```
Interrupt current reading operation (reject the promise that `reader.read()` returned, if any),
and tell to discard further data in the stream.
This leads to calling `source.cancel(reason)`, even if current `source.read()` didn't finish.
`source.cancel()` must implement the actual behavior on how to discard further data,
and finalize the source, as no more callbacks will be called.

In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked.

- **[Symbol.asyncIterator], values**

```ts
function RdStream[Symbol.asyncIterator](options?: {preventCancel?: boolean});
function RdStream.values(options?: {preventCancel?: boolean});
```
Allows to iterate this stream yielding `Uint8Array` data chunks.

Usually you want to use `for await...of` to iterate.
```ts
for await (const chunk of rdStream)
{	// ...
}
```
It's also possible to iterate manually. In this case you need to be "using" the iterator, or to call `releaseLock()` explicitly.
```ts
using it = rdStream.values();
while (true)
{	const {value, done} = await it.next();
	if (done)
	{	break;
	}
	// ...
}
```

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

- **tee**

```ts
function RdStream.tee(options?: {requireParallelRead?: boolean}): [RdStream, RdStream];
```
Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.

If you'll read from one stream faster than from another, or will not read at all from one of them,
the default behavior is to buffer the data.

If `requireParallelRead` option is set, the buffering will be disabled,
and parent stream will suspend after each item, till it's read by both of the child streams.
In this case if you read and await from the first stream, without previously starting reading from the second,
this will cause a deadlock situation.

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

- **pipeTo**

```ts
function RdStream.pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions): Promise<void>;

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
But then `pipeTo()` can be called again to continue piping the rest of the input stream to another destination (including the chunk that previous `pipeTo()` failed to write).

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

- **pipeThrough**

```ts
function RdStream.pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
(	transform:
	{	readonly writable: W;
		readonly readable: R;
	},
	options?: PipeOptions
): R;
```
Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other object that implements the `Transform` interface (has `writable/readable` pair).

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

- **uint8Array**

```ts
function RdStream.uint8Array(): Promise<Uint8Array>;
```
Reads the whole stream to memory.

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

- **text**

```ts
function RdStream.text(label?: string, options?: TextDecoderOptions): Promise<string>;
```
Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.

If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.

### Static methods:

- **from**

```ts
static function RdStream.from<R>(source: AsyncIterable<R> | Iterable<R | PromiseLike<R>>): ReadableStream<R> & RdStream
```
Constructs `RdStream` from an iterable of `Uint8Array`.
Note that `ReadableStream<Uint8Array>` is also iterable of `Uint8Array`, so it can be converted to `RdStream`,
and the resulting `RdStream` will be a wrapper on it.

If you have data source that implements both `ReadableStream<Uint8Array>` and `Deno.Reader`, it's more efficient to create wrapper from `Deno.Reader`
by calling the `RdStream` constructor.

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

This class extends [WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream`<Uint8Array>`.

### Constructor:

```ts
function WrStream.constructor(sink: Sink);

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
		The callback can process the writing completely or partially, and it must return number of bytes processed
		(how many bytes from the beginning of the chunk are written).
		If it processed only a part, the rest of the chunk, and probably additional bytes,
		will be passed to the next call to `write()`.
		This callback must not return 0.
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
readonly WrStream.locked: boolean;
```

When somebody wants to start writing to this stream, he calls `wrStream.getWriter()`, and after that call the stream becomes locked.
Future calls to `wrStream.getWriter()` will throw error till the writer is released (`writer.releaseLock()`).

Other operations that write to the stream (like `wrStream.writeAll()`) also lock it (internally they get writer, and release it later).

### Methods:

- **getWriter**

```ts
function WrStream.getWriter(): WritableStreamDefaultWriter<Uint8Array>;
```
Returns object that allows to write data to the stream.
The stream becomes locked till this writer is released by calling `writer.releaseLock()` or `writer[Symbol.dispose]()`.

If the stream is already locked, this method throws error.

- **getWriterWhenReady**

```ts
function WrStream.getWriterWhenReady(): Promise<WritableStreamDefaultWriter<Uint8Array>>;
```

Like `wrStream.getWriter()`, but waits for the stream to become unlocked before returning the writer (and so locking it again).

- **abort**

```ts
function WrStream.abort(reason?: Any): Promise<void>;
```

Interrupt current writing operation (reject the promise that `writer.write()` returned, if any),
and set the stream to error state.
This leads to calling `sink.abort(reason)`, even if current `sink.write()` didn't finish.
`sink.abort()` is expected to interrupt or complete all the current operations,
and finalize the sink, as no more callbacks will be called.

In contrast to `WritableStream.abort()`, this method works even if the stream is locked.

- **close**

```ts
function WrStream.close(): Promise<void>;
```

Calls `sink.close()`. After that no more callbacks will be called.

- **writeAtom**

```ts
function WrStream.writeAtom(chunk: Uint8Array): Promise<void>;
```
Waits for the stream to be unlocked, gets writer (locks the stream),
writes the chunk, and then releases the writer (unlocks the stream).
This is the same as doing:
```ts
const writer = await wrStream.getWriterWhenReady();
try
{	await writer.write(chunk);
}
finally
{	writer.releaseLock();
}
```

- **enqueue**

```ts
function WrStream.enqueue(chunk: Uint8Array);
```
Puts the chunk to queue to be written when previous write requests complete.
The chunk that you pass must not be modified later by somebody till it gets written to the stream.
If write failed, you'll get exception when you close the stream by calling `writer.close()`.

```ts
const ws = new WrStream({write: p => Deno.stdout.write(p)});
ws.enqueue(new TextEncoder().encode('ABC'));
ws.enqueue(new TextEncoder().encode('DEF'));
using w = await ws.getWriterWhenReady();
await w.close();
```

## class TrStream

This class extends [TransformStream](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream)`<Uint8Array, Uint8Array>`.

### Constructor:

```ts
function TrStream.constructor(transformer: Transformer);

type Transformer =
{	start?(writer: Writer): void | PromiseLike<void>;
	transform?(writer: Writer, chunk: Uint8Array, canReturnZero: boolean): number | PromiseLike<number>;
	flush?(writer: Writer): void | PromiseLike<void>;
};
```

### Properties:

- **writable**

```ts
readonly TrStream.writable: WrStream;
```

Input for the original stream.
All the bytes written here will be transformed by this object, and will be available for reading from `TrStream.readable`.

- **readable**

```ts
readonly TrStream.readable: RdStream;
```

Outputs the transformed stream.
