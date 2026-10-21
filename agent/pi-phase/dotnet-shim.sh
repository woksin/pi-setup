#!/bin/sh
# Only search the pre-shim PATH; also exclude the shim's physical directory.
search=$PI_PHASE_ORIGINAL_PATH
real_dotnet=
while :; do
    dir=${search%%:*}
    dir=${dir:-.}
    physical=$(CDPATH= cd -P -- "$dir" 2>/dev/null && pwd)
    if [ "$physical" != "$PI_PHASE_SHIM_DIR" ] && [ -f "$dir/dotnet" ] && [ -x "$dir/dotnet" ]; then
        real_dotnet=$dir/dotnet
        break
    fi
    case $search in
        *:*) search=${search#*:} ;;
        *) break ;;
    esac
done
if [ -z "$real_dotnet" ]; then
    echo 'pi-phase: dotnet not found on original PATH' >&2
    exit 127
fi
index=0
subcommand=0
cap=yes
for arg do
    index=$((index + 1))
    lower=$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')
    case $lower in
        -m|-m:*|/m|/m:*|-maxcpucount*|/maxcpucount*|--maxcpucount*) cap=no ;;
    esac
    if [ "$subcommand" -eq 0 ]; then
        case $arg in
            -*) ;;
            *)
                subcommand=-1
                case $arg in
                    build|test|publish|pack|msbuild|restore) subcommand=$index ;;
                esac
                ;;
        esac
    fi
done
if [ "$cap" = yes ] && [ "$subcommand" -gt 0 ]; then
    # The for-list is expanded before set replaces the positional parameters.
    index=0
    for arg do
        if [ "$index" -eq 0 ]; then set --; fi
        index=$((index + 1))
        set -- "$@" "$arg"
        if [ "$index" -eq "$subcommand" ]; then
            set -- "$@" "-m:$PI_PHASE_MSBUILD_MAX_CPU"
        fi
    done
fi
exec "$real_dotnet" "$@"
