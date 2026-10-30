#!/bin/sh
# Started as root: fence this container's egress, then run the app as $CONTAIN_USER (bun) with no
# capabilities left. Started as that user already: run the app as is.
set -e

if [ "$(id -u)" != 0 ]; then
    exec "$@"
fi
user=${CONTAIN_USER:-bun}

# Networks this container sits on (the database, cobalt, the vpn), minus each one's gateway: the host.
nets=$(ip -4 route show scope link | awk '{print $1}')
gateways=$(echo "$nets" | awk -F'[./]' 'NF { print $1"."$2"."$3"."$4+1 }')
list() { echo "$@" | tr -s ' \n,' ',' | sed 's/^,//; s/,$//'; }
allow=$(list $nets $EGRESS_ALLOW)

nft -f - <<RULES
table inet egress {
    chain output {
        type filter hook output priority filter; policy accept;
        ct state established,related accept
        oifname "lo" accept
        ip daddr { $(list $gateways) } reject with icmpx type admin-prohibited
        ip daddr { $allow } accept
        ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } reject with icmpx type admin-prohibited
        ip6 daddr { ::/127, ::ffff:0:0/96, 64:ff9b::/96, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8 } reject with icmpx type admin-prohibited
    }
}
RULES

# Alpine's /bin/setpriv is BusyBox (no --reuid) and shadows the util-linux one in /usr/bin.
setpriv=$(command -v /usr/bin/setpriv || command -v setpriv)
exec "$setpriv" --reuid="$user" --regid="$user" --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs "$@"
