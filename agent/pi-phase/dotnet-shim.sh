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
subcommand_name=
assemblies=no
cap=yes
msbuild=yes
shared=yes
reuse=yes
property_next=no
# Shared compilation only: MSBuild node reuse stays off, because reused nodes outlive the phase.
if [ "${PI_PHASE_SHARED_COMPILATION:-}" = 1 ]; then
    shared=no
fi
for arg do
    index=$((index + 1))
    lower=$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')
    case $lower in
        -*) ;;
        *.dll|*.exe) assemblies=yes ;;
    esac
    case $lower in
        -m|-m:*|/m|/m:*|-maxcpucount*|/maxcpucount*|--maxcpucount*) cap=no ;;
    esac
    properties=
    if [ "$property_next" = yes ]; then properties=$lower; fi
    property_next=no
    case $lower in
        -p|-property|--property|/p|/property) property_next=yes ;;
        -p:*|-property:*|--property:*|/p:*|/property:*) properties=${lower#*:} ;;
        -p=*|-property=*|--property=*|/p=*|/property=*) properties=${lower#*=} ;;
    esac
    case $properties in
        usesharedcompilation=*|*\;usesharedcompilation=*|*,usesharedcompilation=*) shared=no ;;
    esac
    case $lower in
        -nodereuse|-nodereuse:*|-nodereuse=*|/nodereuse|/nodereuse:*|/nodereuse=*|--nodereuse|--nodereuse:*|--nodereuse=*|\
        -nr|-nr:*|-nr=*|/nr|/nr:*|/nr=*|--nr|--nr:*|--nr=*) reuse=no ;;
    esac
    if [ "$subcommand" -eq 0 ]; then
        case $arg in
            -*) ;;
            *)
                subcommand=-1
                subcommand_name=$arg
                case $arg in
                    build|test|publish|pack|msbuild|restore) subcommand=$index ;;
                esac
                ;;
        esac
    fi
done
if [ "$subcommand_name" = test ]; then
    if [ "$assemblies" = yes ] || "$PI_PHASE_PYTHON" "$PI_PHASE_SHIM_DIR/test-runner.py"; then
        msbuild=no
    fi
fi
if [ "$msbuild" = yes ] && [ "$subcommand" -gt 0 ]; then
    # The for-list is expanded before set replaces the positional parameters.
    index=0
    for arg do
        if [ "$index" -eq 0 ]; then set --; fi
        index=$((index + 1))
        set -- "$@" "$arg"
        if [ "$index" -eq "$subcommand" ]; then
            if [ "$cap" = yes ]; then set -- "$@" "-m:$PI_PHASE_MSBUILD_MAX_CPU"; fi
            if [ "$shared" = yes ]; then set -- "$@" "-p:UseSharedCompilation=false"; fi
            if [ "$reuse" = yes ]; then set -- "$@" "-nodeReuse:false"; fi
        fi
    done
fi
exec "$real_dotnet" "$@"
