#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
SSH_ALLOW_CIDRS=${SSH_ALLOW_CIDRS-'81.69.102.0/24,106.55.203.0/24,101.33.121.0/24,101.32.250.0/24,119.45.60.0/24'}
export SSH_ALLOW_CIDRS
if ! cidrs=$(node --input-type=module - <<'NODE'
import net from 'node:net';
const values = (process.env.SSH_ALLOW_CIDRS ?? '').trim().split(/[,\s]+/).filter(Boolean);
if (!values.length) process.exit(2);
for (const value of values) {
  const [address, prefix, extra] = value.split('/');
  const family = net.isIP(address);
  if (!family || prefix === undefined || extra !== undefined || !/^\d{1,3}$/.test(prefix) || Number(prefix) < (family === 4 ? 16 : 32) || Number(prefix) > (family === 4 ? 32 : 128)) process.exit(2);
}
process.stdout.write([...new Set(values)].join('\n'));
NODE
); then
  echo 'SSH_ALLOW_CIDRS must contain explicit CIDRs with IPv4 prefix >= 16 and IPv6 prefix >= 32; unrestricted sources are forbidden' >&2
  exit 2
fi
mapfile -t sources <<< "$cidrs"
echo 'cloud security group: manual; generate the same TCP 22 source rules in the cloud console; deny all other inbound'
echo 'ufw default deny incoming'
echo 'ufw default allow outgoing'
for source in "${sources[@]}"; do echo "ufw allow from $source to any port 22 proto tcp"; done
echo 'ufw --force enable'
echo 'plan: require clean inbound allow-list; abort on existing rules; retain console recovery access'
(( apply )) || exit 0
[[ $EUID = 0 ]] || { echo 'authorized root operator required for ufw' >&2; exit 2; }
# Never alter the cloud security group, reset the firewall, or retain broad historical exceptions.
rules=$(ufw show added)
if [[ "$rules" == *'ufw allow '* || "$rules" == *'ufw limit '* || "$rules" == *'ufw route '* ]]; then
  echo 'existing allow rules require operator review before applying' >&2; exit 2
fi
ufw default deny incoming
ufw default allow outgoing
for source in "${sources[@]}"; do ufw allow from "$source" to any port 22 proto tcp; done
ufw --force enable
