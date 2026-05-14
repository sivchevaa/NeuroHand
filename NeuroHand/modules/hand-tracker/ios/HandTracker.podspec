require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HandTracker'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'NeuroHand'
  s.homepage       = 'https://github.com/placeholder'
  s.license        = 'MIT'
  s.platform       = :ios, '15.1'
  s.source         = { git: '' }
  s.source_files   = '*.swift'
  s.resources      = ['*.task']
  s.frameworks     = 'AVFoundation'
  s.dependency 'ExpoModulesCore'
  s.dependency 'MediaPipeTasksVision'
end
