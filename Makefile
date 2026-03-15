include $(TOPDIR)/rules.mk

PKG_NAME:=regulatrix
PKG_VERSION:=1.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Cyrus Rahman <crahman@gmail.com>
PKG_LICENSE:=BSD-Source-Code

include $(INCLUDE_DIR)/package.mk
 
define Package/regulatrix
	SECTION:=Network
	CATEGORY:=Network
	SUBMENU:=Config
	TITLE:=Regulate upload/download rates per mac address
	URL:=https://github.com/signetica/regulatrix
	MAINTAINER:=Cyrus Rahman <crahman@gmail.com>
	EXTRA_DEPENDS:= +tc-tiny +iptables-nft +kmod-sched
	PKGARCH:=all
endef
 
define Package/regulatrix/description
 The Regulatrix will discipline your network.
 Specify a MAC address and the desired rates, and Regulatrix 
 will use htb and sfq qdiscs to enforce bandwith limits.
endef
 
define Build/Compile
endef

define Package/regulatrix/install
	$(INSTALL_DIR) $(1)/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/regulatrix.sh $(1)/sbin/regulatrix
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) files/regulatrix.init $(1)/etc/init.d/regulatrix
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) files/regulatrix.conf $(1)/etc/config/regulatrix
endef

$(eval $(call BuildPackage,regulatrix))
