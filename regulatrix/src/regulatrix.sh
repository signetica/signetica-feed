#!/bin/sh
#
###
# Copyright 2026 Cyrus Rahman
# You may use or modify this source code in any way you find useful, provided
# that you agree that the author(s) have no warranty, obligations or liability.  You
# must determine the suitability of this source code for your use.
#
# Redistributions of this source code must retain this copyright notice.
###
#
# Regulate upload/download rates from a local network - e.g. br-lan - to an Internet
# interface (wan, wwan, etc.).  This is especially useful if you have Ring or similar
# cameras which will happily upload at 4k, but which will gracefully provide
# reasonable imagery at much lower rates (e.g. 300kbit) if you compel them to. Likewise,
# video downloaders may attempt to receive the highest resolution attainable but
# 720p might do just as well as 4k for many applications.  High rates of movement
# will require more data, low levels less.
#
# Ring recommendations for maximal requirements:
#  4k:		15Mbps
#  2k:		10Mbps
#  1536p:	2.5Mbps
#  1080p:	2Mbps
#  720p:	1Mbps
#
# MAC addresses are used to specify the devices for which bandwith should be regulated.
# Each device will be put in a separate class with its own guaranteed rate and ceiling.
#
# Separate qdiscs are set up for uploads and downloads.  Devices are added to them
# as required by the config.
#
# All bandwidth values in the config file must be specified in kbit units.
#
# View activity via:
#   tc [-p -d] -s (class|filter|qdisc) show dev $DEVICE
#   iptables [-v] -t mangle -L PREROUTING
#   bmon -p '$WAN_DEV,$LAN_DEV,qdisc*,class*'

# Load config parsing functions
. /lib/functions.sh

# Load the global parameters from the config file:
#  LAN_DEV	Regulated devices reside on this network.  Usually 'br-lan'
#  WAN_DEV	The outbound device, usually 'wan'.
#  LAN_R2Q	Rate to quantum divisor, htb default is 10.
#  WAN_R2Q	Rate to quantum divisor, htb default is 10.
#  IB_BW	Bandwidth of the inbound channel (to be made available).
#  OB_BW	Bandwidth of the outbound channel (to be made available).
#  ENABLE_IN	Enable inbound filter.
#  ENABLE_OUT   Enable outbound filter.
read_globals() {
  handle_global_config() {
    local config="$1"
    config_get LAN_DEV $config lan_dev unspec
    config_get WAN_DEV $config wan_dev unspec
    config_get LAN_R2Q $config lan_r2q unspec
    config_get WAN_R2Q $config wan_r2q unspec
    config_get IB_BW $config inbound_rate unspec
    config_get OB_BW $config outbound_rate unspec
    config_get_bool ENABLE_IN $config enable_inbound_filter 0
    config_get_bool ENABLE_OUT $config enable_outbound_filter 0
  }

  config_load regulatrix
  config_foreach handle_global_config global
  if [ "$LAN_DEV" = "unspec" -o "$WAN_DEV" = "unspec" \
       -o "$LAN_R2Q" = "unspec" -o "$WAN_R2Q" = "unspec" \
       -o "$IB_BW" = "unspec" -o "$OB_BW" = "unspec" ];
  then
    echo regulatrix: configuration file error
    exit 1
  fi
}

# Parse the config file.
#  Actions:
#    Calculate and return the specified (inbound or outbound) reserved bandwidth:
#      configure_devices reserved inbound|outbound
#    Parse rates at which the devices may transfer data, and then configure the
#    specified (inbound or outbound) qdisc:
#      configure_devices configure inbound|outbound
configure_devices() {
  local cb_action=$1
  local direction=$2
  local reserved_bw

  config_cb() {
    local name="$1"
    local value="$2"
    local ceil rate

    if [ "$name" = "device" ];
    then
      option_cb() {
        local name="$1"
        local value="$2"
        eval $name=\"$value\"
      }
    else
      option_cb() {
        return
      }
    fi

    eval rate=\${${direction}_rate}
    eval ceil=\${${direction}_ceil}
    [ -z "$ceil" ] && ceil=$rate

    local dev_spec="$mac_address $id $rate $ceil"
    if [ "$mac_address" -a "$id" -a "$rate" ];
    then
      [ "$cb_action" = "reserved" ] &&
       reserved_bw=$((${reserved_bw%kbit} + ${rate%kbit}))kbit
      [ "$cb_action" = "configure" ] && filter_mac $direction ${dev_spec}
    fi

    # Optional options, flush to prevent pass-through to subsequent devices.
    unset inbound_rate outbound_rate inbound_ceil outbound_ceil
  }

  config_load regulatrix

  if [ "$cb_action" = "reserved" ];
  then
    if [ "$reserved_bw" ];
    then
      echo $reserved_bw
    else
      echo "0kbit"
    fi
  fi
}

# Set mark on packets from $LAN_DEV with specified MAC address, then add marked
# packets to filter.  Each device gets its own class with an SFQ leaf qdisc to
# provide fair queuing among concurrent flows within the class.
filter_mac() {
  local direction=$1
  local mac=$2
  local id=$3
  local rate=$4
  local ceil=$5

  if [ "$direction" = "outbound" ];
  then
    iptables -A PREROUTING -t mangle -i $LAN_DEV \
             -m mac --mac-source $mac \
             -m comment --comment 'regulate_tx_bw' \
             -j MARK --set-mark $id

    tc class add dev $WAN_DEV parent 1:1 classid 1:$id htb rate $rate ceil $ceil
    tc qdisc add dev $WAN_DEV parent 1:$id handle $id: sfq perturb 10
    tc filter add dev $WAN_DEV parent 1: protocol ip prio 5 handle $id fw flowid 1:$id
  else
    tc class add dev $LAN_DEV parent 1:1 classid 1:$id htb rate $rate ceil $ceil
    tc qdisc add dev $LAN_DEV parent 1:$id handle $id: sfq perturb 10
    tc filter add dev $LAN_DEV parent 1: protocol ip prio 5 u32 match ether dst $mac flowid 1:$id
  fi
}

# Delete any previously loaded qdisc and iptables configuration.
flush_filters() {
  local direction=$1
  local output

  if [ "$direction" = "outbound" ];
  then
    output=`iptables-save -t mangle |\
            sed -n '/PREROUTING.*comment.*regulate_tx_bw/s/-A/iptables -t mangle -D/p'`
    echoeval "${output}"
    tc qdisc del dev $WAN_DEV root 2> /dev/null
  else
    tc qdisc del dev $LAN_DEV root 2> /dev/null
  fi
}

# Add and configure the qdiscs and filters.
configure_filters() {
  local direction=$1
  local bandwidth device r2q reserved_bw unreserved_bw

  case $direction in
    inbound)
      bandwidth=$IB_BW
      device=$LAN_DEV
      r2q=$LAN_R2Q
      ;;

    outbound)
      bandwidth=$OB_BW
      device=$WAN_DEV
      r2q=$WAN_R2Q
      ;;
  esac

  # Enable HTB rate estimation counters.  Note: this is a system-global setting
  # and will affect all HTB qdiscs on the system, not just those created here.
  echoeval 'echo 1 > /sys/module/sch_htb/parameters/htb_rate_est'

  # Obtain the unreserved bandwidth.
  reserved_bw=$(configure_devices reserved $direction)
  unreserved_bw=$((${bandwidth%kbit} - ${reserved_bw%kbit}))kbit
  if [ ${unreserved_bw%kbit} -lt "0" ];
  then
    logger -s -t regulatrix -p daemon.err "Sum of reserved bandwith ($reserved_bw) exceeds channel capacity ($bandwidth)"
    exit 1
  fi

  flush_filters $direction

  # Add qdisc and base classes.  The default class 1:10 catches all unregulated
  # traffic and also gets an SFQ leaf for fair flow scheduling.
  tc qdisc add dev $device root       handle 1:    htb default 10 r2q $r2q
  tc class add dev $device parent 1:  classid 1:1  htb rate $bandwidth
  tc class add dev $device parent 1:1 classid 1:10 htb rate $unreserved_bw ceil $bandwidth
  tc qdisc add dev $device parent 1:10 handle 10: sfq perturb 10

  # Add classes, filters, and iptable rules for each regulated device.
  configure_devices configure $direction
}

start_regulation() {
  [ "$ENABLE_IN" -eq 1 ] && configure_filters inbound
  [ "$ENABLE_OUT" -eq 1 ] && configure_filters outbound
}

stop_regulation() {
  [ "$ENABLE_IN" -eq 1 ] && flush_filters inbound
  [ "$ENABLE_OUT" -eq 1 ] && flush_filters outbound
}

# Redefineable for debugging output.
echoeval() {
  eval "$@"
}

####################################

# Load LAN_DEV, WAN_DEV, LAN_R2Q, WAN_R2Q, IB_BW, OB_BW, ENABLE_IN, ENABLE_OUT
read_globals

case $1 in
  reload|restart|start)
    logger -t regulatrix -p daemon.info Starting regulatrix
    start_regulation
    ;;
  debug)
    # In debug mode, tc/iptables rules are output without execution.
    echoeval() {
      echo $*
    }
    iptables() {
      echo iptables $*
    }
    tc() {
      echo tc $*
    }

    logger -t regulatrix -p daemon.info Starting regulatrix in debug mode
    start_regulation
    ;;
  stop)
    logger -t regulatrix -p daemon.info Stopping regulatrix
    stop_regulation
    ;;
  *)
    echo "Usage: `basename $0` [debug|reload|restart|start|stop]"
    ;;
esac

exit 0
