#!/usr/bin/env bash
set -euo pipefail

# kill anything on 443/3000
fuser -k 443/tcp  || true
fuser -k 3000/tcp || true

# cert paths (Cloudflare Origin cert you saved)
export TLS_CERT=/etc/ssl/cloudflare/yapzac.crt
export TLS_KEY=/etc/ssl/cloudflare/yapzac.key

# allow node to bind 443 (only needed once per node binary)
setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")" || true

# make sure no PORT override
unset PORT

# start the HTTPS server
exec node main.js
