package com.jaquesbody.sorted;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  /**
   * The phone's navigation bar stays on screen over the app unless something
   * asks for it to go. Edge-to-edge is mandatory from API 35 and the opt-out was
   * removed in 36, so leaving it alone means it is permanently there — which is
   * what it was, on a bottom-bar app where it steals the strip the bar itself
   * wants.
   *
   * Transient-by-swipe is deliberate. Hiding a system bar outright with no way
   * back would trap someone who needs the back gesture or the recents button.
   * This way a swipe from the edge brings the bars back for a moment and they
   * hide themselves again on their own.
   *
   * Re-applied on focus change because the bars come back after a swipe, after
   * the permission dialog, and after returning from another app.
   */
  // Before super.onCreate(), because that is what builds and loads the bridge —
  // registerPlugin() only queues the class on the builder, so a plugin named
  // after it is not there is a name the web side can reach and nothing else.
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SaveFilePlugin.class);
    super.onCreate(savedInstanceState);
    hideSystemBars();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  private void hideSystemBars() {
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.hide(WindowInsetsCompat.Type.navigationBars());
    controller.setSystemBarsBehavior(
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }
}
