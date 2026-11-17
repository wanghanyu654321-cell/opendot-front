#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
echo 'plan: check installed Node >=22, Docker Engine >=29 and Compose >=5; no installation or host changes'
# Read-only checks run in both preview and apply; the deployment user needs Docker access.
if ! engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || ! plugin=$(docker compose version --short 2>/dev/null); then
  echo 'Docker >=29 and Compose >=5 must already be installed and accessible; ask the host operator' >&2
  exit 2
fi
engine_major=${engine%%.*}
plugin=${plugin#v}
plugin_major=${plugin%%.*}
if [[ ! "$engine_major" =~ ^[0-9]{1,3}$ || ! "$plugin_major" =~ ^[0-9]{1,3}$ ]] || (( 10#$engine_major < 29 || 10#$plugin_major < 5 )); then
  echo 'Docker >=29 and Compose >=5 required; ask the host operator to install or upgrade before deploying' >&2
  exit 2
fi
echo "host_versions_ok: Docker $engine; Compose $plugin"
