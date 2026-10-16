<?php
/**
 * Plugin Name: JellyBean Visitor Presence
 * Description: Sends signed arrival hints to JellyBean using your existing Crisp widget. Does not install another chat widget.
 * Version: 1.0.0
 * Requires at least: 6.2
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 */

defined('ABSPATH') || exit;

final class JellyBean_Visitor_Presence {
    const OPTION = 'jellybean_presence';
    const BACKEND = 'https://fjscqsatzsmfivpczaud.supabase.co/functions/v1/crisp-site-arrival';
    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    public static function init() {
        add_action('admin_menu', array(__CLASS__, 'menu'));
        add_action('admin_init', array(__CLASS__, 'settings'));
        add_action('wp_enqueue_scripts', array(__CLASS__, 'enqueue'), 100);
        add_action('rest_api_init', array(__CLASS__, 'routes'));
    }

    public static function activate() {
        // Never autoload the signing key into every WordPress request.
        add_option(self::OPTION, array('enabled' => false), '', false);
    }

    private static function config() {
        $config = get_option(self::OPTION, array());
        if (defined('JELLYBEAN_PRESENCE_KEY')) {
            $config['key'] = JELLYBEAN_PRESENCE_KEY;
        }
        return $config;
    }

    private static function origin() {
        $parts = wp_parse_url(home_url('/'));
        if (!$parts || !isset($parts['scheme'], $parts['host']) || 'https' !== $parts['scheme']) {
            return '';
        }
        return 'https://' . strtolower($parts['host']) . (isset($parts['port']) ? ':' . $parts['port'] : '');
    }

    public static function menu() {
        add_options_page('JellyBean Presence', 'JellyBean Presence', 'manage_options', 'jellybean-presence', array(__CLASS__, 'page'));
    }

    public static function settings() {
        register_setting('jellybean_presence_group', self::OPTION, array(
            'type' => 'array', 'show_in_rest' => false,
            'sanitize_callback' => array(__CLASS__, 'sanitize'),
        ));
    }

    public static function sanitize($input) {
        $old = get_option(self::OPTION, array());
        if (!current_user_can('manage_options') || !is_array($input)) {
            return $old;
        }
        $id = isset($input['website_id']) ? strtolower(trim((string) $input['website_id'])) : '';
        if (!preg_match('/^' . self::UUID . '$/D', $id)) {
            add_settings_error(self::OPTION, 'invalid_id', 'Enter the Crisp Website ID (UUID), not the plugin ID.');
            return $old;
        }
        $key = isset($input['key']) ? trim((string) $input['key']) : '';
        if ('' === $key) {
            $key = isset($old['key']) ? $old['key'] : '';
        }
        $effective_key = defined('JELLYBEAN_PRESENCE_KEY') ? JELLYBEAN_PRESENCE_KEY : $key;
        if (!preg_match('/^[0-9a-f]{64}$/D', $effective_key) || '' === self::origin()) {
            add_settings_error(self::OPTION, 'invalid_key', 'A dedicated 64-character site key and an HTTPS WordPress Site Address are required.');
            return $old;
        }
        return array('website_id' => $id, 'key' => $key, 'enabled' => !empty($input['enabled']));
    }

    public static function page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        $config = self::config();
        ?>
        <div class="wrap">
            <h1>JellyBean Visitor Presence</h1>
            <p>Keep the existing Crisp plugin active. This relay does not install a second widget or send messages itself.</p>
            <?php settings_errors(self::OPTION); ?>
            <form method="post" action="options.php">
                <?php settings_fields('jellybean_presence_group'); ?>
                <table class="form-table" role="presentation">
                    <tr><th scope="row">Enable arrival relay</th><td>
                        <input type="checkbox" name="jellybean_presence[enabled]" value="1" <?php checked(!empty($config['enabled'])); ?>>
                    </td></tr>
                    <tr><th scope="row"><label for="jb-website">Crisp Website ID</label></th><td>
                        <input id="jb-website" class="regular-text" name="jellybean_presence[website_id]" value="<?php echo esc_attr(isset($config['website_id']) ? $config['website_id'] : ''); ?>" required>
                    </td></tr>
                    <tr><th scope="row"><label for="jb-key">Dedicated site signing key</label></th><td>
                        <input id="jb-key" type="password" class="regular-text" name="jellybean_presence[key]" value="" autocomplete="new-password" <?php disabled(defined('JELLYBEAN_PRESENCE_KEY')); ?>>
                        <p class="description">Leave blank to keep the saved key. Obtain this site's key through your password manager. Never use a Crisp token, webhook secret, or Supabase key.</p>
                    </td></tr>
                    <tr><th scope="row">Site origin to register with CRM operations</th><td><code><?php echo esc_html(self::origin()); ?></code></td></tr>
                </table>
                <?php submit_button(); ?>
            </form>
            <p>Turn off the relay here or deactivate this plugin to roll back. Existing Crisp chat and CRM polling keep running.</p>
            <p>Browser endpoint: <code><?php echo esc_html(rest_url('jellybean/v1/arrival')); ?></code></p>
        </div>
        <?php
    }

    public static function enqueue() {
        $config = self::config();
        if (empty($config['enabled']) || empty($config['key']) || empty($config['website_id']) || '' === self::origin()) {
            return;
        }
        wp_enqueue_script('jellybean-presence', plugins_url('assets/presence.js', __FILE__), array(), '1.0.0', true);
        // ONLY public configuration. No shared key, visitor name, email or token.
        wp_add_inline_script('jellybean-presence', 'window.JellyBeanPresence=' . wp_json_encode(array(
            'websiteId' => $config['website_id'],
            'endpoint' => rest_url('jellybean/v1/arrival'),
        ), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . ';', 'before');
    }

    public static function routes() {
        register_rest_route('jellybean/v1', '/arrival', array(
            'methods' => 'POST', 'callback' => array(__CLASS__, 'arrival'),
            // Intentionally public for anonymous visitors. This is NOT visitor
            // authentication. The backend verifies actual presence via Crisp.
            'permission_callback' => array(__CLASS__, 'permission'),
        ));
    }

    public static function permission($request) {
        $config = self::config();
        return !empty($config['enabled']) && !empty($config['key']) &&
            '' !== self::origin() && self::origin() === $request->get_header('origin');
    }

    private static function response($status, $code) {
        return new WP_REST_Response(array('status' => $status), $code, array('Cache-Control' => 'no-store'));
    }

    public static function arrival($request) {
        if (strlen($request->get_body()) > 1024) {
            return self::response('invalid', 413);
        }
        if (0 !== strpos(strtolower($request->get_header('content-type')), 'application/json')) {
            return self::response('invalid', 415);
        }
        $body = $request->get_json_params();
        if (!is_array($body) || !isset($body['session_id'], $body['request_id']) ||
            !is_string($body['session_id']) || !is_string($body['request_id']) ||
            !preg_match('/^session_' . self::UUID . '$/D', $body['session_id']) ||
            !preg_match('/^' . self::UUID . '$/D', $body['request_id'])) {
            return self::response('invalid', 400);
        }
        $config = self::config();
        // Best-effort edge protection; backend has atomic per-site limits too.
        // Do not trust X-Forwarded-For; do not retain the IP itself.
        $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
        $rate_key = 'jb_pr_' . hash_hmac('sha256', $ip, wp_salt('nonce'));
        $rate = get_transient($rate_key);
        if (!is_array($rate) || $rate['start'] < time() - 60) {
            $rate = array('start' => time(), 'count' => 0);
        }
        if ($rate['count'] >= 10) {
            return self::response('limited', 429);
        }
        $rate['count']++;
        set_transient($rate_key, $rate, 60);
        $session_key = 'jb_ps_' . hash('sha256', $body['session_id']);
        if (get_transient($session_key)) {
            return self::response('duplicate', 200);
        }
        $raw = wp_json_encode(array('website_id' => $config['website_id'],
            'session_id' => $body['session_id'], 'request_id' => $body['request_id']));
        $timestamp = sprintf('%.0f', microtime(true) * 1000);
        $signature = hash_hmac('sha256', $timestamp . '.' . $raw, $config['key']);
        $result = wp_remote_post(self::BACKEND, array(
            'timeout' => 5, 'redirection' => 0, 'sslverify' => true,
            'headers' => array('Content-Type' => 'application/json',
                'X-JellyBean-Origin' => self::origin(), 'X-JellyBean-Timestamp' => $timestamp,
                'X-JellyBean-Signature' => $signature),
            'body' => $raw, 'limit_response_size' => 1024,
        ));
        if (is_wp_error($result)) {
            return self::response('unavailable', 503);
        }
        $code = wp_remote_retrieve_response_code($result);
        if ($code >= 200 && $code < 300) {
            set_transient($session_key, true, 120);
            return self::response('accepted', 202);
        }
        // Never forward raw backend errors, keys or headers to visitors.
        return self::response(429 === $code ? 'limited' : 'unavailable', 429 === $code ? 429 : 503);
    }
}

register_activation_hook(__FILE__, array('JellyBean_Visitor_Presence', 'activate'));
JellyBean_Visitor_Presence::init();
