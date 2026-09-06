import ExpoModulesCore

public class HandTrackerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HandTracker")

    View(HandTrackerView.self) {
      Events("onHandLandmarks")

      AsyncFunction("takeSnapshot") { (view: HandTrackerView) -> String in
        try await view.takeSnapshot()
      }
    }
  }
}
