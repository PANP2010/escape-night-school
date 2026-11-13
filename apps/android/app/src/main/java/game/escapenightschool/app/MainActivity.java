package game.escapenightschool.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.*;
import android.widget.FrameLayout;
import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "http://night-school.local";
    private static final String DEFAULT_SERVER = "http://154.217.245.217:4100";
    private WebView web;
    private FrameLayout root;
    private boolean playing;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(16,27,23)); setContentView(root);
        showMenu(); immersive();
    }

    private void destroyWeb() {
        if (web == null) return;
        WebView old = web; web = null;
        old.stopLoading(); old.onPause(); root.removeView(old); old.destroy();
    }
    private void showMenu() {
        playing = false; destroyWeb();
        web = createWebView(); root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        String server = getPreferences(0).getString("server", DEFAULT_SERVER);
        web.loadUrl(ORIGIN + "/launcher/index.html?server=" + encode(server)); immersive();
    }
    private String encode(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
        catch (Exception ex) { return ""; }
    }
    private boolean validServer(String value) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && uri.getHost() != null && !uri.getHost().isEmpty() && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() > 0 && uri.getPort() <= 65535);
        } catch (Exception ex) { return false; }
    }
    private void startGame(String server) {
        if (!validServer(server)) {
            web.evaluateJavascript("window.nativeLaunchFailed && window.nativeLaunchFailed('请输入有效的 HTTP 或 HTTPS 服务器地址。');", null);
            return;
        }
        getPreferences(0).edit().putString("server", server).apply();
        destroyWeb(); playing = true;
        web = createWebView(); root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        web.loadUrl(ORIGIN + "/index.html?server=" + encode(server)); immersive();
    }
    private boolean isLocal(Uri uri) {
        return "http".equals(uri.getScheme()) && "night-school.local".equals(uri.getHost())
            && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 80);
    }
    private boolean isLauncher(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return isLocal(uri) && "/launcher/index.html".equals(uri.getPath());
    }

    @SuppressWarnings("SetJavaScriptEnabled") private WebView createWebView() {
        WebView view = new WebView(this); view.setBackgroundColor(Color.rgb(16,27,23));
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true); settings.setSupportMultipleWindows(false); settings.setTextZoom(100);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView current, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("escape-native".equals(uri.getScheme())) {
                    // Only a gesture in the packaged launcher may issue this narrow navigation command.
                    if (current == web && !playing && request.isForMainFrame() && request.hasGesture() && isLauncher(current.getUrl())) {
                        if ("launch".equals(uri.getHost())) {
                            String value = uri.getQueryParameter("server"); startGame(value == null ? "" : value.trim());
                        } else if ("quit".equals(uri.getHost())) finish();
                    }
                    return true;
                }
                return !isLocal(uri);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView current, WebResourceRequest request) {
                Uri uri = request.getUrl(); if (!isLocal(uri)) return null;
                if (!"GET".equals(request.getMethod())) return failure();
                String path = uri.getPath(); if (path == null || path.equals("/")) path = "/index.html";
                if (path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return failure();
                String asset = path.startsWith("/launcher/") ? path.substring(1) : "web" + path;
                try {
                    String type = mime(path);
                    return new WebResourceResponse(type, type.startsWith("text/") || type.contains("javascript") || type.contains("json") ? "UTF-8" : null,
                        200, "OK", Collections.singletonMap("X-Content-Type-Options", "nosniff"), getAssets().open(asset));
                } catch (IOException ex) { return failure(); }
            }
            @Override public void onReceivedError(WebView current, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || current != web) return;
                runOnUiThread(() -> {
                    if (current != web || isFinishing()) return;
                    new AlertDialog.Builder(MainActivity.this).setTitle("暂时无法进入校园")
                        .setMessage(playing ? "请检查网络或服务器地址，然后重试。" : "启动界面未能打开，请重新安装游戏。")
                        .setPositiveButton(playing ? "返回主界面" : "退出", (d,w) -> { if (playing) showMenu(); else finish(); }).show();
                });
            }
            @Override public void onPageFinished(WebView current, String url) { if (current == web) immersive(); }
        });
        return view;
    }
    private WebResourceResponse failure() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html"; if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css"; if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png"; if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml"; if (p.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
    @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if (focus) immersive(); }
    @Override public void onBackPressed() {
        if (!playing) { finish(); return; }
        new AlertDialog.Builder(this).setTitle("离开校园？").setMessage("返回主界面将断开当前房间。")
            .setNegativeButton("继续游戏", null).setPositiveButton("返回主界面", (d,w) -> showMenu()).show();
    }
    @Override protected void onPause() {
        super.onPause();
        if (web != null) { web.evaluateJavascript("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('pagehide'));", null); web.onPause(); }
    }
    @Override protected void onResume() {
        super.onResume(); if (web != null) { web.onResume(); web.evaluateJavascript("window.dispatchEvent(new Event('pageshow'));", null); }
    }
    @Override protected void onDestroy() { destroyWeb(); super.onDestroy(); }
}
