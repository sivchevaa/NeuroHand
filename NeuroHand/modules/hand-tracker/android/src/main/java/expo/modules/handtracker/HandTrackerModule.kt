package expo.modules.handtracker

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HandTrackerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HandTracker")

    View(HandTrackerView::class) {
      Events("onHandLandmarks")

      OnViewDestroys { view ->
        view.destroy()
      }
    }
  }
}
