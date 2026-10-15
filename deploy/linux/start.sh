#!/bin/sh
set -eu
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$bundle_dir/portviewer-web" serve --listen 127.0.0.1:17890 --assets "$bundle_dir/web-assets" "$@"
