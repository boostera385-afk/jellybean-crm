<?php
// Runs inside a disposable real WordPress Playground, never on an office site.
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
if (!defined('FS_METHOD')) { define('FS_METHOD', 'direct'); }
wp_set_current_user(1);

function jb_assert($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
    echo 'PASS: ' . $message . "\n";
}

$release = '/release/jellybean-presence-1.1.0.zip';
jb_assert(is_file($release), 'Exact release ZIP is mounted');
// Reproduce the office packaging mistake with a harmless local fixture.
$zip = new ZipArchive();
$zip->open('/tmp/office-handoff.zip', ZipArchive::CREATE);
$zip->addFile($release, 'handoff/jellybean-presence-1.1.0.zip');
$zip->addFromString('handoff/INSTALLATION.txt', 'Extract this archive first.');
$zip->close();
$bad = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$bad_result = $bad->install('/tmp/office-handoff.zip');
$bad_error = is_wp_error($bad_result) ? $bad_result : $bad->skin->result;
echo 'Nested ZIP installer result: ' . wp_json_encode(is_wp_error($bad_error) ? $bad_error->get_error_codes() : $bad->skin->get_upgrade_messages()) . "\n";
jb_assert(is_wp_error($bad_error) && in_array('incompatible_archive_no_plugins', $bad_error->get_error_codes(), true),
    'Real WordPress installer rejects nested handoff ZIP as no valid plugins');

$upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$installed = $upgrader->install($release);
jb_assert(true === $installed, 'Real WordPress installer accepts plugin release ZIP');
$slug = 'jellybean-presence/jellybean-presence.php';
$plugins = get_plugins();
jb_assert(isset($plugins[$slug]) && '1.1.0' === $plugins[$slug]['Version'], 'WordPress discovers plugin header and version');
jb_assert(null === activate_plugin($slug, '', false, false), 'Plugin activates without a fatal error');
jb_assert(is_plugin_active($slug), 'WordPress records active plugin');
jb_assert(false === get_option('jellybean_presence')['enabled'], 'Fresh installation is disabled until configured');

update_option('home', 'https://example.com');
JellyBean_Visitor_Presence::settings();
$key = str_repeat('a', 64); // Offline fixture; never a real credential.
update_option('jellybean_presence', array('enabled' => true,
    'website_id' => '87065a95-c96e-4f0b-867d-a4bbb47e08ec', 'key' => $key));
jb_assert(get_option('jellybean_presence')['key'] === $key, 'Settings API accepts valid per-site configuration');
ob_start(); JellyBean_Visitor_Presence::page(); $html = ob_get_clean();
jb_assert(false !== strpos($html, 'Test backend connection') && false === strpos($html, $key),
    'Admin page has diagnostics without echoing saved signing key');
JellyBean_Visitor_Presence::enqueue();
$inline = wp_scripts()->registered['jellybean-presence']->extra['before'][0];
jb_assert(false === strpos($inline, $key), 'Actual WordPress script configuration contains no key');

$calls = 0;
add_filter('pre_http_request', function($pre, $args, $url) use ($key, &$calls) {
    if ($url !== JellyBean_Visitor_Presence::BACKEND) { return $pre; }
    $calls++;
    $expected = hash_hmac('sha256', $args['headers']['X-JellyBean-Timestamp'] . '.' . $args['body'], $key);
    jb_assert(hash_equals($expected, $args['headers']['X-JellyBean-Signature']), 'WordPress transport signs exact request bytes');
    $payload = json_decode($args['body'],true);
    $diagnostic = isset($payload['action']) && 'check' === $payload['action'];
    if ($diagnostic) { jb_assert(!isset($payload['session_id']), 'Connection check creates no fake visitor'); }
    return array('headers' => array(), 'body' => $diagnostic ? '{"status":"connected"}' : '{"status":"accepted"}',
        'response' => array('code' => $diagnostic ? 200 : 202, 'message' => 'OK'), 'cookies' => array());
}, 10, 3);
wp_set_current_user(0);
$request = new WP_REST_Request('POST', '/jellybean/v1/arrival');
$request->set_header('origin', 'https://example.com');
$request->set_header('content-type', 'application/json');
$request->set_body(wp_json_encode(array('session_id' => 'session_11111111-1111-4111-8111-111111111111',
    'request_id' => '22222222-2222-4222-8222-222222222222')));
jb_assert(202 === rest_do_request($request)->get_status(), 'Real anonymous WordPress REST route accepts same-origin arrival');
jb_assert(200 === rest_do_request($request)->get_status() && 1 === $calls, 'Real transients suppress duplicate outbound requests');
$request->set_header('origin', 'https://attacker.example');
jb_assert(in_array(rest_do_request($request)->get_status(), array(401,403), true) && 1 === $calls,
    'Real REST permission callback rejects cross-origin request');
wp_set_current_user(1);
// Exercise the actual nonce-protected diagnostics action, intercepting redirect
// only to keep the rest of this single-request test running after success.
class JB_Diagnostic_Redirect extends RuntimeException {}
$_REQUEST['_wpnonce'] = wp_create_nonce('jellybean_presence_check');
$intercept = function() { throw new JB_Diagnostic_Redirect(); };
add_filter('wp_redirect', $intercept);
try { JellyBean_Visitor_Presence::connection_check(); }
catch (JB_Diagnostic_Redirect $e) { /* Expected control flow before exit. */ }
remove_filter('wp_redirect', $intercept);
jb_assert(0 === strpos(get_transient('jb_check_1'), 'Connected:') && 2 === $calls,
    'Real admin nonce action reports authenticated connection success');
deactivate_plugins($slug, true);
jb_assert(!is_plugin_active($slug), 'Plugin deactivates cleanly');
uninstall_plugin($slug);
jb_assert(false === get_option('jellybean_presence'), 'Uninstall removes saved settings');
echo "WordPress release installation and REST tests passed.\n";
