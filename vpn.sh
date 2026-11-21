#!/usr/bin/env bash
set -euo pipefail
umask 077

action=${1:-}
namespace=${2:-}
interface=obswg0
if [[ ! "$namespace" =~ ^obs-vpn-[0-9]+-[0-9]+$ ]]; then
  echo 'Invalid stream VPN namespace.' >&2
  exit 1
fi
namespace_config="/etc/netns/$namespace"

fail() {
  echo "$1" >&2
  exit 1
}

remove_namespace() {
  sudo -n ip -n "$namespace" link delete "$interface" 2>/dev/null || true
  sudo -n ip netns delete "$namespace"
}

if [[ "$action" == down ]]; then
  status=0
  remove_namespace || status=1
  sudo -n rm -rf -- "$namespace_config" || status=1
  exit "$status"
fi
[[ "$action" == up ]] || fail 'Usage: vpn.sh up|down NAME'

config_dir=$(mktemp -d /tmp/obs-vpn.XXXXXXXX)
namespace_created=0
interface_created=0
namespace_config_created=0
cleanup_setup() {
  local status=$?
  rm -rf -- "$config_dir"
  if (( status == 0 )); then return; fi
  if (( namespace_created )); then remove_namespace 2>/dev/null || true; fi
  if (( interface_created )); then sudo -n ip link delete "$interface" 2>/dev/null || true; fi
  if (( namespace_config_created )); then sudo -n rm -rf -- "$namespace_config"; fi
}
trap cleanup_setup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Only core WireGuard values are written to wg.conf. Never invoke wg-quick hooks.
python3 - "$config_dir" 3<&0 <<'PY'
import configparser
import ipaddress
import os
from pathlib import Path
import sys


class ConfigError(Exception):
    pass


def entries(value):
    return [item.strip() for item in value.split(",")]


def load_config(target):
    config = configparser.ConfigParser(
        delimiters=("=",), inline_comment_prefixes=("#",), interpolation=None
    )
    with os.fdopen(3) as source:
        config.read_file(source)
    if config.defaults() or set(config.sections()) != {"Interface", "Peer"}:
        raise ConfigError("WireGuard needs one [Interface] and one [Peer].")

    interface = config["Interface"]
    peer = config["Peer"]
    interface_fields = {"privatekey": "PrivateKey", "listenport": "ListenPort"}
    peer_fields = {
        "publickey": "PublicKey",
        "presharedkey": "PresharedKey",
        "allowedips": "AllowedIPs",
        "endpoint": "Endpoint",
        "persistentkeepalive": "PersistentKeepalive",
    }
    if set(interface) - (interface_fields.keys() | {"address", "dns", "mtu"}) or set(peer) - peer_fields.keys():
        raise ConfigError("WireGuard contains an unsupported field. Remove lifecycle hooks and table overrides.")
    if not {"privatekey", "address", "dns"} <= interface.keys() or not {"publickey", "allowedips", "endpoint"} <= peer.keys():
        raise ConfigError("WireGuard needs Address, DNS, PrivateKey, PublicKey, AllowedIPs and Endpoint.")
    if any(not value or "\n" in value for section in (interface, peer) for value in section.values()):
        raise ConfigError("WireGuard values must be nonempty and fit on one line.")

    addresses = [ipaddress.ip_interface(item) for item in entries(interface["address"])]
    resolvers = [ipaddress.ip_address(item) for item in entries(interface["dns"])]
    allowed = {ipaddress.ip_network(item) for item in entries(peer["allowedips"])}
    families = {address.version for address in addresses}
    if 4 not in families or ipaddress.ip_network("0.0.0.0/0") not in allowed:
        raise ConfigError("WireGuard needs an IPv4 Address and full-tunnel AllowedIPs (0.0.0.0/0).")
    if 6 in families and ipaddress.ip_network("::/0") not in allowed:
        raise ConfigError("IPv6 WireGuard addresses need ::/0 in AllowedIPs.")
    if len(resolvers) > 3 or any(address.version not in families or address.is_loopback or address.is_unspecified for address in resolvers):
        raise ConfigError("Set up to three numeric tunnel DNS addresses in the configured address families.")
    mtu = int(interface.get("mtu", "1420"))
    if not (1280 if 6 in families else 576) <= mtu <= 9000:
        raise ConfigError("Invalid WireGuard MTU for the configured address families.")

    config_lines = ["[Interface]"]
    config_lines.extend(f"{name} = {interface[key]}" for key, name in interface_fields.items() if key in interface)
    config_lines.append("[Peer]")
    config_lines.extend(f"{name} = {peer[key]}" for key, name in peer_fields.items() if key in peer)
    (target / "wg.conf").write_text("\n".join(config_lines) + "\n")
    (target / "addresses").write_text("".join(f"{address}\n" for address in addresses))
    (target / "resolv.conf").write_text("".join(f"nameserver {address}\n" for address in resolvers))
    (target / "mtu").write_text(str(mtu))


try:
    load_config(Path(sys.argv[1]))
except ConfigError as error:
    sys.exit(str(error))
except (configparser.Error, OSError, ValueError):
    sys.exit("Could not read the WireGuard profile. Check its INI format, addresses and DNS.")
PY

sudo -n ip netns add "$namespace" >/dev/null 2>&1 || fail 'Could not create the stream VPN network namespace.'
namespace_created=1
sudo -n ip link add "$interface" type wireguard >/dev/null 2>&1 || fail 'The runner could not create a WireGuard interface.'
interface_created=1
sudo -n timeout 20s env WG_ENDPOINT_RESOLUTION_RETRIES=0 wg setconf "$interface" "$config_dir/wg.conf" >/dev/null 2>&1 \
  || fail 'Could not configure WireGuard. Check the profile credentials and endpoint.'
rm -f -- "$config_dir/wg.conf"
sudo -n ip link set "$interface" netns "$namespace" >/dev/null 2>&1 || fail 'Could not isolate the WireGuard interface.'
interface_created=0

sudo -n mkdir -m 0755 -- "$namespace_config" || fail 'Could not create VPN-specific DNS settings.'
namespace_config_created=1
sudo -n install -m 0644 -- "$config_dir/resolv.conf" "$namespace_config/resolv.conf"
sed -E 's/^hosts:[[:space:]]*.*/hosts: files dns/' /etc/nsswitch.conf > "$config_dir/nsswitch.conf"
sudo -n install -m 0644 -- "$config_dir/nsswitch.conf" "$namespace_config/nsswitch.conf"

configure_link() {
  local address
  local has_ipv6=0
  while IFS= read -r address; do
    sudo -n ip -n "$namespace" address add "$address" dev "$interface" || return
    if [[ "$address" == *:* ]]; then has_ipv6=1; fi
  done < "$config_dir/addresses"
  sudo -n ip -n "$namespace" link set lo up || return
  sudo -n ip -n "$namespace" link set "$interface" mtu "$(<"$config_dir/mtu")" up || return
  sudo -n ip -n "$namespace" -4 route add default dev "$interface" || return
  if (( has_ipv6 )); then sudo -n ip -n "$namespace" -6 route add default dev "$interface" || return; fi
}
configure_link >/dev/null 2>&1 || fail 'Could not configure the VPN address and default route.'

read -r _ probe_address < "$config_dir/resolv.conf"
for attempt in {1..10}; do
  sudo -n ip netns exec "$namespace" ping -n -c 1 -W 2 "$probe_address" >/dev/null 2>&1 || true
  if sudo -n ip netns exec "$namespace" wg show "$interface" latest-handshakes 2>/dev/null \
    | awk '$2 > 0 { ready=1 } END { exit !ready }'; then
    echo 'WireGuard handshake confirmed. Stream connections will use the VPN.'
    exit 0
  fi
  sleep 1
done
fail 'WireGuard handshake timed out. Check the endpoint and UDP connectivity.'
