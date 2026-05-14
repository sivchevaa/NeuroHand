import ExpoModulesCore

public class HandTrackerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HandTracker")

    View(HandTrackerView.self) {
      Events("onHandLandmarks")
    }
  }
}
