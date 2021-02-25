export var PHP_INIT = String.raw
`<?php

class _PhpDenoBridge extends Exception
{	private const REC_HELO = 0;
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
	private const REC_CALL = 27;
	private const REC_CALL_THIS = 28;
	private const REC_CALL_EVAL = 29;
	private const REC_CALL_EVAL_THIS = 30;
	private const REC_CALL_ECHO = 31;
	private const REC_CALL_INCLUDE = 32;
	private const REC_CALL_INCLUDE_ONCE = 33;
	private const REC_CALL_REQUIRE = 34;
	private const REC_CALL_REQUIRE_ONCE = 35;

	private static ?int $error_reporting = null;
	private static array $insts = [];
	private static array $insts_iters = [];
	private static int $inst_id_enum = 0;

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
		// Proceed
		$stdin = fopen('php://stdin', 'r');
		while (!feof($stdin))
		{	try
			{	// 1. Read the request
				$len = fread($stdin, 8);
				if (strlen($len) != 8)
				{	if (strlen($len)==0 or $len=="\n" or $len=="\r" or $len=="\r\n")
					{	continue;
					}
					exit; // Fatal error
				}
				list('T' => $record_type, 'L' => $len) = unpack('NT/NL', $len);
				$data = '';
				while ($len > 0)
				{	$read = fread($stdin, $len);
					$data .= $read;
					$len -= strlen($read);
				}

				// 2. Process the request
				$result = null;
				$result_is_set = false;
				switch ($record_type)
				{	case self::REC_HELO:
						$data = json_decode($data, true);
						$output = stream_socket_client($data[0], $errno, $errstr);
						if ($output === false)
						{	exit("stream_socket_client(): errno=$errno $errstr");
						}
						$result = $data[1];
						$result_is_set = true;
						break;
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
				{	fwrite($output, "\xFF\xFF\xFF\xFF"); // undefined
				}
				else if ($result === null)
				{	fwrite($output, "\0\0\0\0");
				}
				else
				{	$data = json_encode($result);
					fwrite($output, pack('l', strlen($data)).$data);
				}
			}
			catch (Throwable $e)
			{	// 4. Error: send the exception
				$data = json_encode([$e->getFile(), $e->getLine(), $e->getMessage(), $e->getTraceAsString()]);
				fwrite($output, pack('l', -strlen($data)).$data);
			}
			fflush($output);
		}
	}
}

_PhpDenoBridge::main();
?>`;
