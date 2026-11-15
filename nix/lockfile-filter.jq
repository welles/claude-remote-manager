# Keeps the packages of package-lock.json that npm installs on Linux with
# glibc and CPU $cpu (see nix/package.nix). A package is dropped when its
# os, cpu or libc field excludes this platform, or when it is a WebAssembly
# fallback binding; so is everything below it, and its name in the
# dependents' optionalDependencies when no copy of it is left.
def excludes($value):
  if . == null then false
  elif type == "string" then [.] | excludes($value)
  elif any(.[]; startswith("!")) then any(.[]; . == "!" + $value)
  else all(.[]; . != $value)
  end;
def name: sub("^.*node_modules/"; "");

(.packages | to_entries
  | map(select(.key != "" and (
      (.value.os | excludes("linux"))
      or (.value.cpu | excludes($cpu))
      or (.value.libc | excludes("glibc"))
      or (.key | test("-wasm32-wasi$")))))
  | map(.key)) as $dropped
| .packages |= with_entries(select(
    .key as $k | all($dropped[]; ($k != .) and (($k | startswith(. + "/")) | not))))
| (.packages | keys | map(name) | unique) as $left
| ($dropped | map(name) | unique | map(select(. as $n | $left | index($n) | not))) as $gone
| .packages |= map_values(
    if .optionalDependencies then
      .optionalDependencies |= with_entries(select(.key as $k | $gone | index($k) | not))
    else . end)
