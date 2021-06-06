import {dirname, exists} from './deps.ts';

const TMP_SCRIPT_FILENAME_PREFIX = 'deno-php-world';

export const PHP_INIT = String.raw
`<?php

class _PhpDenoBridge extends Exception
{	private const REC_NOREC = 0;
	private const REC_CONST = 1;
	private const REC_GET = 2;
	private const REC_GET_THIS = 3;
	private const REC_SET = 4;
	private const REC_SET_PATH = 5;
	private const REC_UNSET = 6;
	private const REC_UNSET_PATH = 7;
	private const REC_CLASSSTATIC_GET = 8;
	private const REC_CLASSSTATIC_GET_THIS = 9;
	private const REC_CLASSSTATIC_SET = 10;
	private const REC_CLASSSTATIC_SET_PATH = 11;
	private const REC_CLASSSTATIC_UNSET = 12;
	private const REC_CONSTRUCT = 13;
	private const REC_DESTRUCT = 14;
	private const REC_CLASS_GET = 15;
	private const REC_CLASS_GET_THIS = 16;
	private const REC_CLASS_SET = 17;
	private const REC_CLASS_SET_PATH = 18;
	private const REC_CLASS_UNSET = 19;
	private const REC_CLASS_UNSET_PATH = 20;
	private const REC_CLASS_CALL = 21;
	private const REC_CLASS_CALL_PATH = 22;
	private const REC_CLASS_ITERATE_BEGIN = 23;
	private const REC_CLASS_ITERATE = 24;
	private const REC_POP_FRAME = 25;
	private const REC_N_OBJECTS = 26;
	private const REC_END_STDOUT = 27;
	private const REC_DATA = 28;
	private const REC_CALL = 29;
	private const REC_CALL_THIS = 30;
	private const REC_CALL_EVAL = 31;
	private const REC_CALL_EVAL_THIS = 32;
	private const REC_CALL_ECHO = 33;
	private const REC_CALL_INCLUDE = 34;
	private const REC_CALL_INCLUDE_ONCE = 35;
	private const REC_CALL_REQUIRE = 36;
	private const REC_CALL_REQUIRE_ONCE = 37;

	public const RES_ERROR = 1;
	public const RES_GET_CLASS = 2;
	public const RES_CONSTRUCT = 3;
	public const RES_CLASS_GET = 4;
	public const RES_CLASS_SET = 5;
	public const RES_CLASS_CALL = 6;
	public const RES_CLASSSTATIC_CALL = 7;

	private static ?int $error_reporting = null;
	private static string $end_mark = '';
	private static array $insts = [];
	private static array $insts_iters = [];
	private static int $inst_id_enum = 0;
	private static $commands_io;

	public function __construct($message=null, $code=null, $file=null, $line=null)
	{	parent::__construct($message);
		if ($code !== null) $this->code = $code;
		if ($file) $this->file = $file;
		if ($line !== null) $this->line = $line;
	}

	public static function error_handler($err_code, $err_msg, $file, $line)
	{	if (error_reporting(self::$error_reporting) != 0) // error_reporting returns zero if "@" operator was used
		{	throw new self($err_msg, $err_code, $file, $line);
		}
	}

	public static function load_class($class_name)
	{	if (strpos($class_name, 'DenoWorld\\') === 0)
		{	$class_name_2 = substr($class_name, 10);
			$value = self::write_read('['.self::RES_GET_CLASS.','.json_encode($class_name_2).']');
			if ($value === 1)
			{	$pos = strrpos($class_name, '\\');
				$ns = substr($class_name, 0, $pos);
				$basename = substr($class_name, $pos+1);
				eval("namespace $ns; class $basename extends \\DenoWorld {}");
			}
		}
	}

	private static function read_record()
	{	while (!feof(self::$commands_io))
		{	$len = fread(self::$commands_io, 8);
			if (strlen($len) != 8)
			{	if ($len===false or strlen($len)==0 or $len=="\n" or $len=="\r" or $len=="\r\n")
				{	continue;
				}
				return [self::REC_NOREC, '']; // Fatal error
			}
			list('T' => $record_type, 'L' => $len) = unpack('NT/NL', $len);
			$data = '';
			while ($len > 0)
			{	$read = fread(self::$commands_io, $len);
				$data .= $read;
				$len -= strlen($read);
			}
			return [$record_type, $data];
		}
		return [self::REC_NOREC, ''];
	}

	public static function write_read($data)
	{	fwrite(self::$commands_io, pack('l', -strlen($data)).$data);
		list($record_type, $data) = self::read_record();
		assert($record_type == self::REC_DATA);
		list($value, $error) = json_decode($data, true);
		if ($error)
		{	throw new Exception($error['message']);
		}
		return $value;
	}

	private static function get_reflection($class_name)
	{	static $cache = [];
		if (!isset($cache[$class_name]))
		{	$cache[$class_name] = new ReflectionClass($class_name);
		}
		return $cache[$class_name];
	}

	private static function has_static_property($class_name, $prop_name)
	{	static $cache = [];
		if (!isset($cache[$class_name]))
		{	$cache[$class_name] = array_keys(self::get_reflection($class_name)->getStaticProperties());
		}
		return in_array($prop_name, $cache[$class_name]);
	}

	private static function eval($code)
	{	return eval($code);
	}

	private static function follow_path(&$value, $path)
	{	foreach ($path as $p)
		{	if (is_array($value))
			{	if (array_key_exists($p, $value))
				{	$value = $value[$p];
					continue;
				}
			}
			else if (is_object($value))
			{	if (isset($value->$p) or property_exists($value, $p))
				{	$value = $value->$p;
					continue;
				}
			}
			return false;
		}
		return true;
	}

	private static function follow_path_set(&$value, array $path, $new_value)
	{	foreach ($path as $p)
		{	if (is_object($value))
			{	if (isset($value->$p))
				{	$value = &$value->$p;
				}
				else
				{	$value->$p = new stdClass;
					$value = &$value->$p;
				}
			}
			else
			{	if (!is_array($value))
				{	$value = [];
				}
				$value = &$value[$p];
			}
		}
		$value = $new_value;
	}

	private static function follow_path_unset(&$value, array $path, $last_p)
	{	foreach ($path as $p)
		{	if (is_array($value))
			{	if (isset($value[$p]))
				{	$value = &$value[$p];
					continue;
				}
			}
			else if (is_object($value))
			{	if (isset($value->$p))
				{	$value = &$value->$p;
					continue;
				}
			}
			return false;
		}
		unset($value[$last_p]);
	}

	private static function decode_value($data)
	{	return strlen($data)==0 ? null : json_decode($data);
	}

	private static function decode_ident_value($data, &$ident)
	{	$pos = strpos($data, ' ');
		if ($pos === false)
		{	$ident = $data;
			return null;
		}
		else
		{	$ident = substr($data, 0, $pos);
			return json_decode(substr($data, $pos+1), true);
		}
	}

	private static function decode_ident_ident($data, &$ident_a)
	{	$pos = strpos($data, ' ');
		if ($pos === false)
		{	$ident_a = $data;
			return null;
		}
		else
		{	$ident_a = substr($data, 0, $pos);
			return substr($data, $pos+1);
		}
	}

	private static function decode_ident_ident_value($data, &$ident_a, &$ident_b)
	{	$pos = strpos($data, ' ');
		$ident_a = substr($data, 0, $pos);
		$pos++;
		$pos_2 = strpos($data, ' ', $pos);
		if ($pos_2 === false)
		{	$ident_b = substr($data, $pos);
			return null;
		}
		else
		{	$ident_b = substr($data, $pos, $pos_2-$pos);
			return json_decode(substr($data, $pos_2+1), true);
		}
	}

	private static function subst_insts($value)
	{	if (is_array($value))
		{	if (count($value)==1 and ($inst_id = $value['DENO_PHP_WORLD_INST_ID'] ?? -1)>=0)
			{	return self::$insts[$inst_id];
			}
			foreach ($value as $k => $v)
			{	$value[$k] = self::subst_insts($v);
			}
		}
		else if (is_object($value))
		{	foreach ($value as $k => $v)
			{	$value->$k = self::subst_insts($v);
			}
		}
		return $value;
	}

	private static function create_iterator($obj)
	{	foreach ($obj as $value)
		{	yield $value;
		}
	}

	private static function iterate_begin($inst_id)
	{	if (!isset(self::$insts[$inst_id]))
		{	throw new Exception("Object destroyed");
		}
		$obj = self::$insts[$inst_id];
		if (!($obj instanceof Traversable))
		{	throw new Exception("Object is not iterable");
		}
		$iter = self::create_iterator($obj);
		if (!$iter->valid())
		{	return [null, true];
		}
		self::$insts_iters[$inst_id] = $iter;
		$value = $iter->current();
		$iter->next();
		return [$value, false];
	}

	private static function iterate($inst_id)
	{	$iter = self::$insts_iters[$inst_id] ?? null;
		if (!$iter)
		{	throw new Exception("Object destroyed");
		}
		if (!$iter->valid())
		{	unset(self::$insts_iters[$inst_id]);
			return [null, true];
		}
		$value = $iter->current();
		$iter->next();
		return [$value, false];
	}

	public static function main()
	{	global $argc, $argv;

		// Install error handler, that converts E_ERROR to Exception
		self::$error_reporting = error_reporting(); // determine reporting level set by user
		set_error_handler(__CLASS__.'::error_handler', self::$error_reporting);

		// Register class loader
		spl_autoload_register(__CLASS__.'::load_class');

		// Read HELO, that is [key, end_mark, socket_name], and output the key back
		$data = explode(' ', $_SERVER['DENO_WORLD_HELO'] ?? file_get_contents('php://stdin'));
		if (count($data) != 3)
		{	return;
		}
		unset($_SERVER['DENO_WORLD_HELO']);
		$commands_io = stream_socket_client(trim($data[2]), $errno, $errstr);
		if ($commands_io === false)
		{	error_log("stream_socket_client(): errno=$errno $errstr");
			return;
		}
		self::$commands_io = $commands_io;
		stream_set_timeout($commands_io, 0x7FFFFFFF);
		self::$end_mark = base64_decode($data[1]);
		$data = json_encode($data[0]);
		fwrite($commands_io, pack('l', strlen($data)).$data);

		// Proceed
		while (true)
		{	try
			{	// 1. Read the request
				list($record_type, $data) = self::read_record();

				// 2. Process the request
				$result = null;
				$result_is_set = false;
				switch ($record_type)
				{	case self::REC_NOREC:
						break 2;
					case self::REC_CONST:
						if (defined($data))
						{	$result = constant($data);
							$result_is_set = true;
						}
						break;
					case self::REC_GET:
						$data = self::decode_ident_value($data, $prop_name);
						$result_is_set = array_key_exists($prop_name, $GLOBALS);
						if ($result_is_set)
						{	$result = $GLOBALS[$prop_name];
							if ($data !== null)
							{	$result_is_set = self::follow_path($result, $data);
							}
						}
						break;
					case self::REC_GET_THIS:
						$data = self::decode_ident_value($data, $prop_name);
						if (array_key_exists($prop_name, $GLOBALS))
						{	$result = $GLOBALS[$prop_name];
							if ($data!==null and !self::follow_path($result, $data))
							{	throw new Exception('Value is not set');
							}
							$class_name = is_object($result) ? ' '.get_class($result) : '';
							self::$insts[self::$inst_id_enum] = $result;
							$result = self::$inst_id_enum++.$class_name;
							$result_is_set = true;
							break;
						}
						throw new Exception('Value is not set');
					case self::REC_SET:
						$data = self::decode_ident_value($data, $prop_name);
						$GLOBALS[$prop_name] = self::subst_insts($data);
						continue 2;
					case self::REC_SET_PATH:
						list($data, $result) = self::decode_ident_value($data, $prop_name);
						self::follow_path_set($GLOBALS[$prop_name], $data, self::subst_insts($result));
						continue 2;
					case self::REC_UNSET:
						unset($GLOBALS[$data]);
						continue 2;
					case self::REC_UNSET_PATH:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name); // $class_name is the first path element, and $prop_name is the last
						if ($data === null)
						{	unset($GLOBALS[$class_name][$prop_name]);
						}
						else
						{	self::follow_path_unset($GLOBALS[$class_name], $data, $prop_name);
						}
						continue 2;
					case self::REC_CLASSSTATIC_GET:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						try
						{	$result = self::get_reflection($class_name)->getStaticPropertyValue($prop_name);
							$result_is_set = true;
						}
						catch (Throwable $e)
						{	if (self::has_static_property($class_name, $prop_name))
							{	throw $e;
							}
						}
						if ($result_is_set and $data!==null)
						{	$result_is_set = self::follow_path($result, $data);
						}
						break;
					case self::REC_CLASSSTATIC_GET_THIS:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						$result = self::get_reflection($class_name)->getStaticPropertyValue($prop_name);
						if ($data!==null and !self::follow_path($result, $data))
						{	throw new Exception('Value is not set');
						}
						$class_name = is_object($result) ? ' '.get_class($result) : '';
						self::$insts[self::$inst_id_enum] = $result;
						$result = self::$inst_id_enum++.$class_name;
						$result_is_set = true;
						break;
					case self::REC_CLASSSTATIC_SET:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						self::get_reflection($class_name)->setStaticPropertyValue($prop_name, self::subst_insts($data));
						continue 2;
					case self::REC_CLASSSTATIC_SET_PATH:
						list($data, $result) = self::decode_ident_ident_value($data, $class_name, $prop_name);
						$result = self::subst_insts($result);
						eval('self::follow_path_set('.$class_name.'::$'.'{$prop_name}, $data, $result);');
						continue 2;
					case self::REC_CLASSSTATIC_UNSET:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						$value = array_pop($data);
						eval('self::follow_path_unset('.$class_name.'::$'.'{$prop_name}, $data, $value);');
						$value = null;
						continue 2;
					case self::REC_CONSTRUCT:
						$data = self::decode_ident_value($data, $class_name);
						$data = $data===null ? self::get_reflection($class_name)->newInstance() : self::get_reflection($class_name)->newInstanceArgs(self::subst_insts($data));
						self::$insts[self::$inst_id_enum] = $data;
						$result = self::$inst_id_enum++;
						$result_is_set = true;
						break;
					case self::REC_DESTRUCT:
						unset(self::$insts[$data]);
						unset(self::$insts_iters[$data]);
						continue 2;
					case self::REC_CLASS_GET:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						$result = self::$insts[$inst_id];
						$result_is_set = isset($result->$prop_name) || property_exists($result, $prop_name);
						if ($result_is_set)
						{	try
							{	$result = $result->$prop_name;
								if ($data !== null)
								{	$result_is_set = self::follow_path($result, $data);
								}
							}
							catch (Throwable $e)
							{	$result_is_set = false;
							}
						}
						break;
					case self::REC_CLASS_GET_THIS:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						$result = self::$insts[$inst_id];
						$result = $result->$prop_name;
						if ($data!==null and !self::follow_path($result, $data))
						{	throw new Exception('Value is not set');
						}
						$class_name = is_object($result) ? ' '.get_class($result) : '';
						self::$insts[self::$inst_id_enum] = $result;
						$result = self::$inst_id_enum++.$class_name;
						$result_is_set = true;
						break;
					case self::REC_CLASS_SET:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						self::$insts[$inst_id]->$prop_name = self::subst_insts($data);
						continue 2;
					case self::REC_CLASS_SET_PATH:
						list($data, $result) = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						self::follow_path_set(self::$insts[$inst_id]->$prop_name, $data, self::subst_insts($result));
						continue 2;
					case self::REC_CLASS_UNSET:
						$prop_name = self::decode_ident_ident($data, $inst_id);
						unset(self::$insts[$inst_id]->$prop_name);
						continue 2;
					case self::REC_CLASS_UNSET_PATH:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						self::follow_path_unset(self::$insts[$inst_id], $data, $prop_name);
						continue 2;
					case self::REC_CLASS_CALL:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						$result = $data===null ? call_user_func([self::$insts[$inst_id], $prop_name]) : call_user_func_array([self::$insts[$inst_id], $prop_name], self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CLASS_CALL_PATH:
						list($data, $result) = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						$value = self::$insts[$inst_id];
						self::follow_path($value, $data);
						$result = call_user_func_array([$value, $prop_name], self::subst_insts($result));
						$value = null;
						$result_is_set = true;
						break;
					case self::REC_CLASS_ITERATE_BEGIN:
						$result = self::iterate_begin($data);
						$result_is_set = true;
						break;
					case self::REC_CLASS_ITERATE:
						$result = self::iterate($data);
						$result_is_set = true;
						break;
					case self::REC_POP_FRAME:
						foreach (self::$insts as $inst_id => $result)
						{	if ($inst_id > $data)
							{	unset(self::$insts[$inst_id]);
								unset(self::$insts_iters[$inst_id]);
							}
						}
						self::$inst_id_enum = $data + 1;
						continue 2;
					case self::REC_N_OBJECTS:
						$result = count(self::$insts);
						$result_is_set = true;
						break;
					case self::REC_END_STDOUT:
						echo self::$end_mark;
						flush();
						continue 2;
					case self::REC_CALL:
						$data = self::decode_ident_value($data, $prop_name);
						$result = $data===null ? call_user_func($prop_name) : call_user_func_array($prop_name, self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CALL_THIS:
						$data = self::decode_ident_value($data, $prop_name);
						$data = $data===null ? call_user_func($prop_name) : call_user_func_array($prop_name, self::subst_insts($data));
						$class_name = is_object($data) ? ' '.get_class($data) : '';
						self::$insts[self::$inst_id_enum] = $data;
						$result = self::$inst_id_enum++.$class_name;
						$result_is_set = true;
						break;
					case self::REC_CALL_EVAL:
						$data = self::decode_value($data);
						$result = self::eval(self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CALL_EVAL_THIS:
						$data = self::decode_value($data);
						$data = self::eval(self::subst_insts($data));
						$class_name = is_object($data) ? ' '.get_class($data) : '';
						self::$insts[self::$inst_id_enum] = $data;
						$result = self::$inst_id_enum++.$class_name;
						$result_is_set = true;
						break;
					case self::REC_CALL_ECHO:
						$data = self::subst_insts(self::decode_value($data));
						foreach ($data as $arg)
						{	echo $arg;
						}
						break;
					case self::REC_CALL_INCLUDE:
						$data = self::decode_value($data);
						$result = include(self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CALL_INCLUDE_ONCE:
						$data = self::decode_value($data);
						$result = include_once(self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CALL_REQUIRE:
						$data = self::decode_value($data);
						$result = require(self::subst_insts($data));
						$result_is_set = true;
						break;
					case self::REC_CALL_REQUIRE_ONCE:
						$data = self::decode_value($data);
						$result = require_once(self::subst_insts($data));
						$result_is_set = true;
						break;
				}

				// 3. Send the result
				if (!$result_is_set)
				{	fwrite($commands_io, "\xFF\xFF\xFF\xFF"); // undefined
				}
				else if ($result === null)
				{	fwrite($commands_io, "\0\0\0\0");
				}
				else
				{	$data = json_encode($result);
					fwrite($commands_io, pack('l', strlen($data)).$data);
				}
			}
			catch (Throwable $e)
			{	// 4. Error: send the exception
				$data = json_encode([self::RES_ERROR, $e->getFile(), $e->getLine(), $e->getMessage(), $e->getTraceAsString()]);
				fwrite($commands_io, pack('l', -strlen($data)).$data);
			}
			fflush($commands_io);
		}
	}
}

class DenoWorld
{	private $inst_id;

	public function __construct()
	{	$args = func_get_args();
		$class_name = substr(get_class($this), 10); // cut DenoWorld\ prefix
		$value = _PhpDenoBridge::write_read('['._PhpDenoBridge::RES_CONSTRUCT.','.json_encode($class_name).','.json_encode($args).']');
		$this->inst_id = (int)$value;
	}

	public function __get($name)
	{	return _PhpDenoBridge::write_read('['._PhpDenoBridge::RES_CLASS_GET.','.$this->inst_id.','.json_encode($name).']');
	}

	public function __set($name, $value)
	{	_PhpDenoBridge::write_read('['._PhpDenoBridge::RES_CLASS_SET.','.$this->inst_id.','.json_encode($name).','.json_encode($value).']');
	}

	public function __call($name, $args)
	{	return _PhpDenoBridge::write_read('['._PhpDenoBridge::RES_CLASS_CALL.','.$this->inst_id.','.json_encode($name).','.json_encode($args).']');
	}

	public static function __callStatic($name, $args)
	{	$class_name = substr(get_called_class(), 10); // cut DenoWorld\ prefix
		return _PhpDenoBridge::write_read('['._PhpDenoBridge::RES_CLASSSTATIC_CALL.','.json_encode($class_name).','.json_encode($name).','.json_encode($args).']');
	}
}

_PhpDenoBridge::main();
?>`;

let php_init_filename = '';
export async function get_php_init_filename(is_debug=false)
{	if (!php_init_filename)
	{	// create a temp file
		let tmp_name = await Deno.makeTempFile();
		// figure out what is tmp dir
		let tmp_dirname = dirname(tmp_name);
		tmp_dirname = tmp_name.slice(0, tmp_dirname.length+1); // inclide dir separator char
		// form new tmp filename and store to php_init_filename
		let suffix = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
		php_init_filename = is_debug ? `${tmp_dirname}${TMP_SCRIPT_FILENAME_PREFIX}.php` : `${tmp_dirname}${TMP_SCRIPT_FILENAME_PREFIX}-${suffix}-pid${Deno.pid}.php`;
		// rename the tmp file to the new name
		await Deno.rename(tmp_name, php_init_filename);
		// find files left from previous runs
		let unowned_filenames = [];
		try
		{	if (await exists(`/proc`))
			{	for await (const {isFile, name} of Deno.readDir(tmp_dirname))
				{	if (isFile && name.startsWith(TMP_SCRIPT_FILENAME_PREFIX) && name.endsWith('.php'))
					{	let pos = name.indexOf('-', TMP_SCRIPT_FILENAME_PREFIX.length+1);
						if (pos!=-1 && name.substr(pos+1, 3)=='pid')
						{	let pid = Number(name.slice(pos+4, -4));
							if (pid)
							{	if (!await exists(`/proc/${pid}`))
								{	unowned_filenames.push(name);
								}
							}
						}
					}
				}
			}
		}
		catch (e)
		{	console.error(e);
		}
		// delete unowned files
		for (let f of unowned_filenames)
		{	try
			{	await Deno.remove(tmp_dirname+f);
			}
			catch (e)
			{	console.error(e);
			}
		}
		// register cleanup for my tmp file
		if (!is_debug)
		{	addEventListener
			(	'unload',
				() =>
				{	Deno.removeSync(php_init_filename);
				}
			);
		}
	}
	else
	{	// if existing file is of valid size, use it
		try
		{	let stat = await Deno.stat(php_init_filename);
			if (stat.isFile && stat.size==PHP_INIT.length)
			{	return php_init_filename;
			}
		}
		catch
		{
		}
	}
	// write PHP_INIT file
	await Deno.writeTextFile(php_init_filename, PHP_INIT, {mode: 0o640});
	// done
	return php_init_filename;
}
