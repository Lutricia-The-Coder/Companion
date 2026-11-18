package expo.modules.companionmonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class MonitorSafeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action == CompanionMonitorService.ACTION_CONFIRM_SAFE) {
      context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean("checkInPending", false).remove("checkInDeadlineAt").apply()
      context.startService(Intent(context, CompanionMonitorService::class.java).setAction(CompanionMonitorService.ACTION_CONFIRM_SAFE))
    }
  }
}
