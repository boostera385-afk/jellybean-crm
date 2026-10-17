<?php
// Offline smoke tests with WordPress stubs. No network requests or real keys.
define('ABSPATH', __DIR__);
$options = array('website_id' => '87065a95-c96e-4f0b-867d-a4bbb47e08ec', 'key' => str_repeat('a', 64), 'enabled' => true);
$transients = array(); $outbound = array(); $inline = ''; $transport_status = 202;
function add_action() {}
function register_activation_hook() {}
function get_option($name, $fallback = array()) { return $GLOBALS['options']; }
function home_url($path) { return 'https://example.com' . $path; }
function wp_parse_url($url) { return parse_url($url); }
function current_user_can($capability) { return true; }
function add_settings_error() {}
function plugins_url($path, $file) { return 'https://example.com/plugins/' . $path; }
function wp_enqueue_script() {}
function wp_enqueue_style() {}
function wp_add_inline_script($handle, $value) { $GLOBALS['inline'] = $value; }
function rest_url($path) { return 'https://example.com/wp-json/' . $path; }
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
function wp_salt($name) { return 'test-only-salt'; }
function get_transient($key) { return isset($GLOBALS['transients'][$key]) ? $GLOBALS['transients'][$key] : false; }
function set_transient($key, $value, $ttl) { $GLOBALS['transients'][$key] = $value; }
function wp_remote_post($url, $args) { $GLOBALS['outbound'][] = array($url, $args); return array('status' => $GLOBALS['transport_status']); }
function wp_remote_retrieve_response_code($result) { return $result['status']; }
function wp_remote_retrieve_body($result) { return json_encode(array('status' => 'accepted')); }
function is_wp_error($result) { return false; }
class WP_REST_Response {
    public $data; public $status;
    public function __construct($data, $status, $headers) { $this->data = $data; $this->status = $status; }
}
class Test_Request {
    private $body; private $origin;
    public function __construct($body, $origin = 'https://example.com') { $this->body = $body; $this->origin = $origin; }
    public function get_body() { return $this->body; }
    public function get_json_params() { return json_decode($this->body, true); }
    public function get_header($key) { return 'origin' === $key ? $this->origin : 'application/json'; }
}
function check($condition, $description) {
    if (!$condition) { throw new RuntimeException($description); }
    echo 'PASS: ' . $description . PHP_EOL;
}
require __DIR__ . '/../jellybean-presence/jellybean-presence.php';

$request = new Test_Request(json_encode(array('session_id' => 'session_11111111-1111-4111-8111-111111111111',
    'request_id' => '22222222-2222-4222-8222-222222222222')));
check(JellyBean_Visitor_Presence::permission($request), 'Same-origin anonymous requests allowed only when configured');
check(!JellyBean_Visitor_Presence::permission(new Test_Request('{}', 'https://attacker.example')), 'Cross-origin request blocked');
check(!JellyBean_Visitor_Presence::permission(new Test_Request('{}', '')), 'Missing Origin rejected');
JellyBean_Visitor_Presence::enqueue();
check(false === strpos($inline, str_repeat('a', 64)), 'Site key absent from browser configuration');
check(false !== strpos($inline, 'websiteId'), 'Only public configuration enqueued');
$sanitized = JellyBean_Visitor_Presence::sanitize(array('website_id' => $options['website_id'], 'key' => '', 'enabled' => '1'));
check($sanitized['key'] === $options['key'], 'Blank password retains saved key');
check(JellyBean_Visitor_Presence::sanitize(array('website_id' => 'bad')) === $options, 'Invalid ID preserves settings');
check(JellyBean_Visitor_Presence::arrival(new Test_Request('{}'))->status === 400, 'Malformed arrival rejected');
check(JellyBean_Visitor_Presence::arrival(new Test_Request(str_repeat('x', 1025)))->status === 413, 'Oversized arrival rejected');
$result = JellyBean_Visitor_Presence::arrival($request);
check(202 === $result->status && 1 === count($outbound), 'One signed server-to-server request accepted');
$args = $outbound[0][1];
$expected = hash_hmac('sha256', $args['headers']['X-JellyBean-Timestamp'] . '.' . $args['body'], $options['key']);
check(hash_equals($expected, $args['headers']['X-JellyBean-Signature']), 'Raw bytes signed with per-site HMAC');
check(5 === $args['timeout'] && 0 === $args['redirection'] && true === $args['sslverify'], 'Bounded HTTPS transport, no redirects');
check(!isset(json_decode($args['body'], true)['key']), 'Payload contains no secret');
check(200 === JellyBean_Visitor_Presence::arrival($request)->status && 1 === count($outbound), 'Duplicate causes no second outbound request');
$transients = array(); $transport_status = 401;
check(503 === JellyBean_Visitor_Presence::arrival($request)->status, 'Upstream auth failure not presented as success');
$transients = array(); $transport_status = 202;
for ($i = 0; $i < 10; $i++) { JellyBean_Visitor_Presence::arrival($request); }
check(429 === JellyBean_Visitor_Presence::arrival($request)->status, 'Local per-IP rate cap enforced');
echo 'All offline PHP relay tests passed.' . PHP_EOL;
