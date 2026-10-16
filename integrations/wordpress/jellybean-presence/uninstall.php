<?php
defined('WP_UNINSTALL_PLUGIN') || exit;
delete_option('jellybean_presence');
// Short-lived rate/dedup transients expire naturally. No visitor data is stored
// in plugin options. Revoke the dedicated site key in JellyBean when retiring it.
