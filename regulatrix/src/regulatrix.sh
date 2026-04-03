#!/bin/sh
#
###
# Copyright 2026 Cyrus Rahman
# You may use or modify this source code in any way you find useful, provided
# that you agree that the author(s) have no warranty, obligations or liability.  You
# must determine the suitability of this source code for your use.
#
# Redistributions of this source code must retain this copyright notice.
#
###
#  MAC address fixed traffic shaping:
#
# Regulate upload/download rates from a local network - e.g. br-lan - to an Internet
# interface (wan, wwan, etc.).  This is especially useful if you have Ring or similar
# cameras which will happily upload at 4k, but which will gracefully provide
# reasonable imagery at much lower rates (e.g. 300kbit) if you compel them to. Likewise,
# video downloaders may attempt to receive the highest resolution attainable but
# 720p might do just as well as 4k for many applications.  High rates of movement
# will require more data, low levels less.
#
# Ring recommendations for optimal quality.  Far lower rates may work very well:
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
###
#  Quota-based traffic shaping:
#    (based upon the idea in Sam Wilson's trafficshaper.sh - 
#     https://github.com/Kahn/scripts/tree/master/openwrt)
#
# The MAC address rules are appropriate for fixed devices such as cameras or
# televisions.  They are less useful for transient devices such as phones or
# tablets or devices which use variable MAC addresses - but which will also
# display useful video at lower resolutions if bandwidth is restricted.  For
# these devices a quota-based download traffic shaping system is available and
# may be applied to an address range (e.g. a dynamic DHCP range).
#
# Devices in the range start at full speed and are progressively throttled as they
# consume data, using the iptables quota2 module. The quota subtree
# attaches as a child of the default class 1:10, replacing the SFQ leaf qdisc.
#
# MAC address regulated hosts should usually be given IP addresses outside of the
# quota-based address range.

# All bandwidth values in the config file must be specified in kbit units.
#
# View activity via:
#   tc [-p -d] -s (class|filter|qdisc) show dev $DEVICE
#   iptables [-v] -t mangle -L <POSTROUTING|PREROUTING>
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
    config_get IB_BW   $config inbound_rate unspec
    config_get OB_BW   $config outbound_rate unspec
    config_get_bool ENABLE_IN  $config enable_inbound_filter 0
    config_get_bool ENABLE_OUT $config enable_outbound_filter 0
  }

  config_load regulatrix
  config_foreach handle_global_config global
  if [ "$LAN_DEV" = "unspec" -o "$WAN_DEV" = "unspec" \
       -o "$LAN_R2Q" = "unspec" -o "$WAN_R2Q" = "unspec" \
       -o "$IB_BW" = "unspec" -o "$OB_BW" = "unspec" ];
  then
    logger -s -t regulatrix -p daemon.err "Configuration file error"
    stop_regulation
    exit 1
  fi
}

# Load quota parameters from the config file:
#  QUOTA_ENABLE	  Enable quota-based shaping on the default inbound class.
#  QUOTA_LAN_ADDR The (class c) LAN_DEV network address (e.g. 192.168.1.0).
#  QUOTA_IP_START First host address of the shaped range.
#  QUOTA_IP_END	  Last host address of the shaped range.
#  QUOTA_T1_BW	  Tier 1 ceiling (full speed) in kbit.
#  QUOTA_T2_BW	  Tier 2 ceiling (reduced) in kbit.
#  QUOTA_T3_BW	  Tier 3 rate/ceiling (floor) in kbit.
#  QUOTA_T1	  Tier 1 quota in bytes.
#  QUOTA_T2	  Tier 2 quota in bytes.
read_quotas() {
  handle_quota_config() {
    local config="$1"
    config_get_bool QUOTA_ENABLE $config enable_quotas 0
    config_get QUOTA_LAN_ADDR $config lan_addr unspec
    config_get QUOTA_IP_START $config range_start unspec
    config_get QUOTA_IP_END   $config range_end unspec
    config_get QUOTA_T1_BW    $config t1_rate unspec
    config_get QUOTA_T2_BW    $config t2_rate unspec
    config_get QUOTA_T3_BW    $config t3_rate unspec
    config_get QUOTA_T1       $config t1_quota unspec
    config_get QUOTA_T2       $config t2_quota unspec
  }

  config_load regulatrix
  config_foreach handle_quota_config quotas

  [ ! "$QUOTA_ENABLE" ] && QUOTA_ENABLE=0
  if [ "$QUOTA_ENABLE" -eq 1 ];
  then
    if [ "$QUOTA_LAN_ADDR" = "unspec" \
         -o "$QUOTA_IP_START" = "unspec" -o "$QUOTA_IP_END" = "unspec" \
         -o "$QUOTA_T1_BW" = "unspec" -o "$QUOTA_T2_BW" = "unspec" \
         -o "$QUOTA_T3_BW" = "unspec" \
         -o "$QUOTA_T1" = "unspec" -o "$QUOTA_T2" = "unspec" ];
    then
      logger -s -t regulatrix -p daemon.err "Quota configuration incomplete"
      stop_regulation
      exit 1
    fi
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
  local reserved_bw duplicate

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
    [ ! "$enabled" ] && enabled=1

    local dev_spec="$mac_address $id $rate $ceil $enabled"
    if [ "$mac_address" -a "$id" -a "$rate" ];
    then
      if [ "$cb_action" = "reserved" -a "$enabled" -eq 1 ];
      then
        reserved_bw=$((${reserved_bw%kbit} + ${rate%kbit}))kbit
 
        # Check for duplicated ids while calculating reserved_bw.
        [ ! "$duplicate" ] && eval "[ \${seen_${id}} ]" && duplicate=$id
        eval seen_${id}=1
      fi
      [ "$cb_action" = "configure" ] && filter_mac $direction ${dev_spec}
    fi

    # Optional options, flush to prevent pass-through to subsequent devices.
    unset inbound_rate outbound_rate inbound_ceil outbound_ceil enabled
  }

  config_load regulatrix

  if [ "$duplicate" ];
  then
    logger -s -t regulatrix -p daemon.err "Duplicate id $duplicate in configuration file"
    return 1
  fi

  if [ "$cb_action" = "reserved" ];
  then
    if [ "$reserved_bw" ];
    then
      echo $reserved_bw
    else
      echo "0kbit"
    fi
  fi
  return 0
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
  local enabled=$6

  [ "$enabled" -eq 1 ] || return
  if [ "$direction" = "outbound" ];
  then
    iptables -A PREROUTING -t mangle -i $LAN_DEV \
             -m mac --mac-source $mac \
             -m comment --comment 'regulatrix' \
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
            sed -n '/PREROUTING.*comment.*regulatrix/s/-A/iptables -t mangle -D/p'`
    echoeval "${output}"
    tc qdisc del dev $WAN_DEV root 2> /dev/null
  else
    # Flush quota iptables rules if any exist.
    output=`iptables-save -t mangle |\
            sed -n '/POSTROUTING.*comment.*regulatrix/s/-A/iptables -t mangle -D/p'`
    echoeval "${output}"
    tc qdisc del dev $LAN_DEV root 2> /dev/null
  fi
}

# Configure quota-based traffic shaping on the default inbound class (1:10).
# This replaces the SFQ leaf qdisc on 1:10 with an HTB subtree that
# progressively throttles hosts as they consume their quotas.
#
# The quota2 module provides persistent byte counters.  Three iptables rules
# are evaluated per host, from lowest to highest priority:
#   - Rule 3 (unconditional):  marks traffic for the floor tier.
#   - Rule 2 (quota2 gated):   overwrites the mark while T2 quota remains.
#   - Rule 1 (quota2 gated):   overwrites the mark while T1 quota remains.
# As quotas are exhausted, the higher-priority rules stop matching, and the
# host naturally demotes through the tiers.
configure_quotas() {
  local unreserved_bw="$1"
  local per_host_bw default_class_bw

  # Remove the SFQ leaf qdisc from 1:10 before replacing it with an HTB subtree.
  tc qdisc del dev $LAN_DEV parent 1:10 handle 10: 2> /dev/null

  # Divide and allocate the unreserved_bw to each host/class set, including
  # the default class 2:10.  Only one quota class for each host will be active at
  # a time, so actual bandwidth per host/class will be
  #  unreserved_bw / (QUOTA_IP_END - QUOTA_IP_START + 1 + 1)
  # 
  # If this rate is greater than $QUOTA_T3_BW, we reduce it to $QUOTA_T3_BW and
  # allocate the excess to the default class 2:10.
  per_host_bw=$((${unreserved_bw%kbit} / $(($QUOTA_IP_END - $QUOTA_IP_START + 2))))kbit
  if [ ${per_host_bw%kbit} -gt ${QUOTA_T3_BW%kbit} ];
  then
    per_host_bw=$QUOTA_T3_BW
  fi
  local res_bw=$((${per_host_bw%kbit} * $(($QUOTA_IP_END - $QUOTA_IP_START + 1))))kbit
  default_class_bw=$((${unreserved_bw%kbit} - ${res_bw%kbit}))kbit

  # Create the quota HTB subtree under the default class.
  tc qdisc add dev $LAN_DEV parent 1:10 handle 2: htb default 10 r2q $LAN_R2Q
  tc class add dev $LAN_DEV parent 2: classid 2:1 htb rate $unreserved_bw ceil $IB_BW
  tc class add dev $LAN_DEV parent 2:1 classid 2:10 htb rate $default_class_bw ceil $IB_BW
  tc qdisc add dev $LAN_DEV parent 2:10 handle 4010: sfq perturb 10

  # SFQ handles are made unique by prepending a multiple of 0x1000 to a three-digit
  # representation of the last octet of the ip address, e.g. 1001-1256, 2001, 3001.
  # The default class gets a special multiple, 4010.  This sparsely populates the
  # handle space, but is easy to read.

  # Each host gets three classes (one per tier) and three iptables rules.
  local quota_prefix=${QUOTA_LAN_ADDR%\.*}
  local ip=$QUOTA_IP_START
  while [ $ip -le $QUOTA_IP_END ]; do
    # Three traffic classes per host: full speed, reduced, floor.
    local handle=$(printf '%03d\n' $ip)
    tc class add dev $LAN_DEV parent 2:1 classid 2:${ip}1 htb rate $per_host_bw ceil $QUOTA_T1_BW
    tc class add dev $LAN_DEV parent 2:1 classid 2:${ip}2 htb rate $per_host_bw ceil $QUOTA_T2_BW
    tc class add dev $LAN_DEV parent 2:1 classid 2:${ip}3 htb rate $per_host_bw ceil $QUOTA_T3_BW
    tc qdisc add dev $LAN_DEV parent 2:${ip}1 handle 1${handle}: sfq perturb 10
    tc qdisc add dev $LAN_DEV parent 2:${ip}2 handle 2${handle}: sfq perturb 10
    tc qdisc add dev $LAN_DEV parent 2:${ip}3 handle 3${handle}: sfq perturb 10

    # Filters matching fw marks to classes.
    tc filter add dev $LAN_DEV parent 2: pref 5 protocol ip handle ${ip}001 fw flowid 2:${ip}1
    tc filter add dev $LAN_DEV parent 2: pref 5 protocol ip handle ${ip}002 fw flowid 2:${ip}2
    tc filter add dev $LAN_DEV parent 2: pref 5 protocol ip handle ${ip}003 fw flowid 2:${ip}3

    # iptables rules evaluated bottom-up: unconditional floor mark first,
    # then quota-gated overwrites for higher tiers.
    iptables -t mangle -A POSTROUTING -d $quota_prefix.$ip -j MARK --set-mark ${ip}003 \
      -m comment --comment 'regulatrix'
    iptables -t mangle -A POSTROUTING -d $quota_prefix.$ip -j MARK --set-mark ${ip}002 \
      -m comment --comment 'regulatrix' \
      -m quota2 --quota $QUOTA_T2
    iptables -t mangle -A POSTROUTING -d $quota_prefix.$ip -j MARK --set-mark ${ip}001 \
      -m comment --comment 'regulatrix' \
      -m quota2 --quota $QUOTA_T1

    ip=$(($ip + 1))
  done
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
  if ! reserved_bw=$(configure_devices reserved $direction);
  then
    # Configuration file error. An error message should have already been logged.
    stop_regulation
    exit 1
  fi

  unreserved_bw=$((${bandwidth%kbit} - ${reserved_bw%kbit}))kbit
  if [ ${unreserved_bw%kbit} -le "0" ];
  then
    logger -s -t regulatrix -p daemon.err "Sum of reserved bandwith ($reserved_bw) exceeds channel capacity ($bandwidth)"
    stop_regulation
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

  # If this is the inbound direction and quotas are enabled, replace the SFQ
  # leaf on the default class with the quota HTB subtree.
  if [ "$direction" = "inbound" ] && [ "$QUOTA_ENABLE" -eq 1 ]; then
    configure_quotas $unreserved_bw
  fi
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

# Load QUOTA_ENABLE, QUOTA_LAN_ADDR, QUOTA_IP_START, QUOTA_IP_END, QUOTA_T{1,2,3}_BW,
#      QUOTA_T{1,2}
read_quotas

case $1 in
  reload|restart|start)
    logger -t regulatrix -p daemon.info Starting regulatrix
    start_regulation
    ;;
  debug)
    # In debug mode, tc/iptables rules are output without execution.
    echoeval() {
      echo "$@"
    }
    iptables() {
      echo iptables "$@"
    }
    tc() {
      echo tc "$@"
    }
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
