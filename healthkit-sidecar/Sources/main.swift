import Foundation
import HealthKit

struct SourceMeta: Codable {
    let source: String
    let device: String?
    let sourceName: String?
}

struct Observation: Codable {
    let type: String
    let code: String
    let displayName: String
    let valueReal: Double?
    let valueText: String?
    let unit: String?
    let refLow: Double?
    let refHigh: Double?
    let effectiveDate: Date?
    let sourceMeta: SourceMeta
}

struct CombinedResult: Codable {
    let observations: [Observation]
    let queryDate: Date
    let typesQueried: [String]
}

struct ErrorResponse: Codable {
    let error: String
}

enum QueryKind {
    case cumulative
    case discrete
    case category
    case workout
    case electrocardiogram
}

struct Descriptor {
    let arg: String
    let displayName: String
    let code: String
    let observationType: String
    let unit: String
    let kind: QueryKind
    let objectType: HKObjectType
    let cumulativeOptions: HKStatisticsOptions
}

struct ParsedArgs {
    var type: String = "all"
    var days: Int = 7
    var json: Bool = false
}

func parseArgs(_ argv: [String]) -> ParsedArgs? {
    var parsed = ParsedArgs()
    var i = 1
    while i < argv.count {
        let arg = argv[i]
        switch arg {
        case "--type":
            guard i + 1 < argv.count else { return nil }
            parsed.type = argv[i + 1]
            i += 2
        case "--days":
            guard i + 1 < argv.count, let n = Int(argv[i + 1]), n > 0, n <= 3650 else { return nil }
            parsed.days = n
            i += 2
        case "--json":
            parsed.json = true
            i += 1
        case "--help", "-h":
            FileHandle.standardError.write(Data("""
Usage: healthkit-sidecar --type <dataType> [--days <N>] [--json]

--type   HealthKit data type or 'all'. Supported: steps, stepCount, heartRate,
         restingHeartRate, heartRateVariability, bloodPressureSystolic,
         bloodPressureDiastolic, oxygenSaturation, bodyMass, bodyMassIndex,
         bodyFatPercentage, sleepAnalysis, workout, activeEnergy, exerciseMinutes,
         standHours, flightsClimbed, distanceWalkingRunning, dietaryEnergy,
         caffeine, water, bloodGlucose, electrocardiogram.
--days   Lookback window in days (default 7, max 3650).
--json   Emit JSON to stdout (always on for Holmes integration).

""".utf8))
            return nil
        default:
            FileHandle.standardError.write(Data("Unknown argument: \(arg)\n".utf8))
            return nil
        }
    }
    return parsed
}

func makeDescriptors() throws -> [Descriptor] {
    let store = HKHealthStore.self
    guard store.isHealthDataAvailable() else {
        throw NSError(domain: "HolmesSidecar", code: 1, userInfo: [NSLocalizedDescriptionKey: "HealthKit not available"])
    }
    let q = HKQuantityType.self
    let c = HKCategoryType.self
    let descriptors: [Descriptor] = [
        Descriptor(arg: "steps", displayName: "Steps", code: "HKQuantityTypeIdentifierStepCount", observationType: "vital", unit: "count", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .stepCount)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "stepCount", displayName: "Steps", code: "HKQuantityTypeIdentifierStepCount", observationType: "vital", unit: "count", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .stepCount)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "heartRate", displayName: "Heart Rate", code: "HKQuantityTypeIdentifierHeartRate", observationType: "vital", unit: "count/min", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .heartRate)!,
                   cumulativeOptions: []),
        Descriptor(arg: "restingHeartRate", displayName: "Resting Heart Rate", code: "HKQuantityTypeIdentifierRestingHeartRate", observationType: "vital", unit: "count/min", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .restingHeartRate)!,
                   cumulativeOptions: []),
        Descriptor(arg: "heartRateVariability", displayName: "Heart Rate Variability (SDNN)", code: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", observationType: "vital", unit: "ms", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
                   cumulativeOptions: []),
        Descriptor(arg: "bloodPressureSystolic", displayName: "Blood Pressure Systolic", code: "HKQuantityTypeIdentifierBloodPressureSystolic", observationType: "vital", unit: "mmHg", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bloodPressureSystolic)!,
                   cumulativeOptions: []),
        Descriptor(arg: "bloodPressureDiastolic", displayName: "Blood Pressure Diastolic", code: "HKQuantityTypeIdentifierBloodPressureDiastolic", observationType: "vital", unit: "mmHg", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bloodPressureDiastolic)!,
                   cumulativeOptions: []),
        Descriptor(arg: "oxygenSaturation", displayName: "Oxygen Saturation", code: "HKQuantityTypeIdentifierOxygenSaturation", observationType: "vital", unit: "%", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .oxygenSaturation)!,
                   cumulativeOptions: []),
        Descriptor(arg: "bodyMass", displayName: "Body Mass", code: "HKQuantityTypeIdentifierBodyMass", observationType: "vital", unit: "kg", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bodyMass)!,
                   cumulativeOptions: []),
        Descriptor(arg: "bodyMassIndex", displayName: "Body Mass Index", code: "HKQuantityTypeIdentifierBodyMassIndex", observationType: "vital", unit: "count", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bodyMassIndex)!,
                   cumulativeOptions: []),
        Descriptor(arg: "bodyFatPercentage", displayName: "Body Fat Percentage", code: "HKQuantityTypeIdentifierBodyFatPercentage", observationType: "vital", unit: "%", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bodyFatPercentage)!,
                   cumulativeOptions: []),
        Descriptor(arg: "sleepAnalysis", displayName: "Sleep Analysis", code: "HKCategoryTypeIdentifierSleepAnalysis", observationType: "observation", unit: "min", kind: .category,
                   objectType: c.categoryType(forIdentifier: .sleepAnalysis)!,
                   cumulativeOptions: []),
        Descriptor(arg: "workout", displayName: "Workout", code: "HKWorkoutTypeIdentifierWorkout", observationType: "workout", unit: "min", kind: .workout,
                   objectType: HKWorkoutType.workoutType(),
                   cumulativeOptions: []),
        Descriptor(arg: "activeEnergy", displayName: "Active Energy", code: "HKQuantityTypeIdentifierActiveEnergyBurned", observationType: "vital", unit: "kcal", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .activeEnergyBurned)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "exerciseMinutes", displayName: "Exercise Minutes", code: "HKQuantityTypeIdentifierAppleExerciseTime", observationType: "vital", unit: "min", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .appleExerciseTime)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "standHours", displayName: "Stand Hours", code: "HKCategoryTypeIdentifierAppleStandHour", observationType: "vital", unit: "count", kind: .category,
                   objectType: c.categoryType(forIdentifier: .appleStandHour)!,
                   cumulativeOptions: []),
        Descriptor(arg: "flightsClimbed", displayName: "Flights Climbed", code: "HKQuantityTypeIdentifierFlightsClimbed", observationType: "vital", unit: "count", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .flightsClimbed)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "distanceWalkingRunning", displayName: "Distance Walking+Running", code: "HKQuantityTypeIdentifierDistanceWalkingRunning", observationType: "vital", unit: "km", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .distanceWalkingRunning)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "dietaryEnergy", displayName: "Dietary Energy", code: "HKQuantityTypeIdentifierDietaryEnergyConsumed", observationType: "observation", unit: "kcal", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .dietaryEnergyConsumed)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "caffeine", displayName: "Dietary Caffeine", code: "HKQuantityTypeIdentifierDietaryCaffeine", observationType: "observation", unit: "g", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .dietaryCaffeine)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "water", displayName: "Dietary Water", code: "HKQuantityTypeIdentifierDietaryWater", observationType: "observation", unit: "L", kind: .cumulative,
                   objectType: q.quantityType(forIdentifier: .dietaryWater)!,
                   cumulativeOptions: .cumulativeSum),
        Descriptor(arg: "bloodGlucose", displayName: "Blood Glucose", code: "HKQuantityTypeIdentifierBloodGlucose", observationType: "lab", unit: "mg/dL", kind: .discrete,
                   objectType: q.quantityType(forIdentifier: .bloodGlucose)!,
                   cumulativeOptions: []),
        Descriptor(arg: "electrocardiogram", displayName: "Electrocardiogram", code: "HKElectrocardiogramTypeIdentifier", observationType: "observation", unit: "count", kind: .electrocardiogram,
                   objectType: HKElectrocardiogramType.electrocardiogramType(),
                   cumulativeOptions: []),
    ]
    return descriptors
}

func predicate(forDays days: Int) -> NSPredicate? {
    let cal = Calendar.current
    guard let endDate = cal.date(byAdding: .day, value: 1, to: Date()) else { return nil }
    guard let startDate = cal.date(byAdding: .day, value: -days, to: endDate) else { return nil }
    return HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate, .strictEndDate])
}

func sourceMeta(from sample: HKSample) -> SourceMeta {
    let deviceDisplay = sample.sourceRevision.productType
        ?? sample.device?.model
        ?? sample.device?.name
    return SourceMeta(
        source: "apple_health_live",
        device: deviceDisplay,
        sourceName: sample.sourceRevision.source.name
    )
}

func authorize(_ store: HKHealthStore, descriptors: [Descriptor]) async throws {
    let readTypes = Set(descriptors.map { $0.objectType })
    try await store.requestAuthorization(toShare: [], read: readTypes)
}

func hkUnit(for code: String) -> HKUnit {
    switch code {
    case "HKQuantityTypeIdentifierHeartRate", "HKQuantityTypeIdentifierRestingHeartRate":
        return HKUnit.count().unitDivided(by: .minute())
    case "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":
        return HKUnit.secondUnit(with: .milli)
    case "HKQuantityTypeIdentifierBloodPressureSystolic", "HKQuantityTypeIdentifierBloodPressureDiastolic":
        return .millimeterOfMercury()
    case "HKQuantityTypeIdentifierOxygenSaturation", "HKQuantityTypeIdentifierBodyFatPercentage":
        return .percent()
    case "HKQuantityTypeIdentifierBodyMass":
        return .gramUnit(with: .kilo)
    case "HKQuantityTypeIdentifierBodyMassIndex":
        return .count()
    case "HKQuantityTypeIdentifierBloodGlucose":
        return HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci))
    case "HKQuantityTypeIdentifierActiveEnergyBurned", "HKQuantityTypeIdentifierDietaryEnergyConsumed":
        return .kilocalorie()
    case "HKQuantityTypeIdentifierAppleExerciseTime":
        return .minute()
    case "HKQuantityTypeIdentifierDistanceWalkingRunning":
        return .meterUnit(with: .kilo)
    case "HKQuantityTypeIdentifierDietaryCaffeine":
        return .gramUnit(with: .milli)
    case "HKQuantityTypeIdentifierDietaryWater":
        return .literUnit(with: .milli)
    default:
        return .count()
    }
}

func queryCumulative(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    guard let quantityType = descriptor.objectType as? HKQuantityType else { return [] }
    let cal = Calendar.current
    let interval = DateComponents(day: 1)
    guard let anchorDate = cal.date(bySettingHour: 0, minute: 0, second: 0, of: Date()) else { return [] }
    guard let endDate = cal.date(byAdding: .day, value: 1, to: Date()) else { return [] }
    guard let startDate = cal.date(byAdding: .day, value: -days, to: endDate) else { return [] }
    let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate, .strictEndDate])

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[Observation], Error>) in
        let query = HKStatisticsCollectionQuery(
            quantityType: quantityType,
            quantitySamplePredicate: predicate,
            options: descriptor.cumulativeOptions,
            anchorDate: anchorDate,
            intervalComponents: interval
        )
        query.initialResultsHandler = { _, results, error in
            if let error = error {
                continuation.resume(throwing: error)
                return
            }
            guard let results = results else {
                continuation.resume(returning: [])
                return
            }
            var observations: [Observation] = []
            let unit = hkUnit(for: descriptor.code)
            results.enumerateStatistics(from: startDate, to: endDate, with: { stat, _ in
                guard let sum = stat.sumQuantity() else { return }
                let value = sum.doubleValue(for: unit)
                let valueText = String(format: "%g", value)
                observations.append(Observation(
                    type: descriptor.observationType,
                    code: descriptor.code,
                    displayName: descriptor.displayName,
                    valueReal: value,
                    valueText: valueText,
                    unit: descriptor.unit,
                    refLow: nil,
                    refHigh: nil,
                    effectiveDate: stat.startDate,
                    sourceMeta: SourceMeta(source: "apple_health_live", device: nil, sourceName: "Health")
                ))
            })
            continuation.resume(returning: observations)
        }
        store.execute(query)
    }
}

func queryDiscrete(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    guard let quantityType = descriptor.objectType as? HKQuantityType else { return [] }
    guard let predicate = predicate(forDays: days) else { return [] }
    let unit = hkUnit(for: descriptor.code)
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[Observation], Error>) in
        let query = HKSampleQuery(
            sampleType: quantityType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
        ) { _, samples, error in
            if let error = error {
                continuation.resume(throwing: error)
                return
            }
            guard let quantitySamples = samples as? [HKQuantitySample] else {
                continuation.resume(returning: [])
                return
            }
            let observations = quantitySamples.map { sample in
                let value = sample.quantity.doubleValue(for: unit)
                return Observation(
                    type: descriptor.observationType,
                    code: descriptor.code,
                    displayName: descriptor.displayName,
                    valueReal: value,
                    valueText: String(format: "%g", value),
                    unit: descriptor.unit,
                    refLow: nil,
                    refHigh: nil,
                    effectiveDate: sample.startDate,
                    sourceMeta: sourceMeta(from: sample)
                )
            }
            continuation.resume(returning: observations)
        }
        store.execute(query)
    }
}

func queryCategory(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    guard let categoryType = descriptor.objectType as? HKCategoryType else { return [] }
    guard let predicate = predicate(forDays: days) else { return [] }
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[Observation], Error>) in
        let query = HKSampleQuery(
            sampleType: categoryType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
        ) { _, samples, error in
            if let error = error {
                continuation.resume(throwing: error)
                return
            }
            guard let categorySamples = samples as? [HKCategorySample] else {
                continuation.resume(returning: [])
                return
            }
            if descriptor.code == "HKCategoryTypeIdentifierSleepAnalysis" {
                let grouped = Dictionary(grouping: categorySamples, by: { $0.value })
                let observations = grouped.compactMap { (value, samples) -> Observation? in
                    let totalSeconds = samples.reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) }
                    let minutes = totalSeconds / 60.0
                    let label: String
                    if let sleepValue = HKCategoryValueSleepAnalysis(rawValue: value) {
                        switch sleepValue {
                        case .inBed: label = "Sleep In Bed"
                        case .asleepUnspecified: label = "Sleep Asleep"
                        case .asleepCore: label = "Sleep Core"
                        case .asleepDeep: label = "Sleep Deep"
                        case .asleepREM: label = "Sleep REM"
                        case .awake: label = "Sleep Awake"
                        default: label = "Sleep Other"
                        }
                    } else {
                        label = "Sleep Other"
                    }
                    let earliest = samples.min { $0.startDate < $1.startDate }
                    return Observation(
                        type: descriptor.observationType,
                        code: descriptor.code,
                        displayName: "\(descriptor.displayName) — \(label)",
                        valueReal: minutes,
                        valueText: String(format: "%.1f", minutes),
                        unit: descriptor.unit,
                        refLow: nil,
                        refHigh: nil,
                        effectiveDate: earliest?.startDate,
                        sourceMeta: earliest.map { sourceMeta(from: $0) } ?? SourceMeta(source: "apple_health_live", device: nil, sourceName: "Health")
                    )
                }
                continuation.resume(returning: observations)
                return
            }
            let observations = categorySamples.map { sample in
                let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60.0
                let value = descriptor.code == "HKCategoryTypeIdentifierAppleStandHour" ? 1.0 : minutes
                return Observation(
                    type: descriptor.observationType,
                    code: descriptor.code,
                    displayName: descriptor.displayName,
                    valueReal: value,
                    valueText: String(format: "%g", value),
                    unit: descriptor.unit,
                    refLow: nil,
                    refHigh: nil,
                    effectiveDate: sample.startDate,
                    sourceMeta: sourceMeta(from: sample)
                )
            }
            continuation.resume(returning: observations)
        }
        store.execute(query)
    }
}

func workoutActivityName(_ activityType: HKWorkoutActivityType) -> String {
    switch activityType {
    case .running: return "Running"
    case .cycling: return "Cycling"
    case .walking: return "Walking"
    case .swimming: return "Swimming"
    case .yoga: return "Yoga"
    case .traditionalStrengthTraining: return "Strength Training"
    case .functionalStrengthTraining: return "Functional Strength Training"
    case .hiking: return "Hiking"
    case .rowing: return "Rowing"
    case .elliptical: return "Elliptical"
    case .stairClimbing: return "Stair Climbing"
    case .coreTraining: return "Core Training"
    case .pilates: return "Pilates"
    case .dance: return "Dance"
    case .highIntensityIntervalTraining: return "HIIT"
    case .golf: return "Golf"
    case .tennis: return "Tennis"
    case .basketball: return "Basketball"
    case .soccer: return "Soccer"
    case .americanFootball: return "American Football"
    case .crossTraining: return "Cross Training"
    case .climbing: return "Climbing"
    case .skatingSports: return "Skating"
    case .snowSports: return "Snow Sports"
    case .boxing: return "Boxing"
    case .martialArts: return "Martial Arts"
    case .crossCountrySkiing: return "Cross-Country Skiing"
    case .downhillSkiing: return "Downhill Skiing"
    case .surfingSports: return "Surfing"
    case .waterFitness: return "Water Fitness"
    case .waterPolo: return "Water Polo"
    case .waterSports: return "Water Sports"
    case .flexibility: return "Flexibility"
    case .cooldown: return "Cooldown"
    case .mixedCardio: return "Mixed Cardio"
    case .handCycling: return "Hand Cycling"
    case .barre: return "Barre"
    case .cardioDance: return "Cardio Dance"
    case .socialDance: return "Social Dance"
    case .wheelchairRunPace: return "Wheelchair Run"
    case .wheelchairWalkPace: return "Wheelchair Walk"
    case .other: return "Workout"
    case .preparationAndRecovery: return "Preparation & Recovery"
    case .fitnessGaming: return "Fitness Gaming"
    case .jumpRope: return "Jump Rope"
    case .stepTraining: return "Step Training"
    case .mindAndBody: return "Mind & Body"
    case .paddleSports: return "Paddle Sports"
    default: return "Workout"
    }
}

func queryWorkouts(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    guard let workoutType = descriptor.objectType as? HKWorkoutType else { return [] }
    guard let predicate = predicate(forDays: days) else { return [] }
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[Observation], Error>) in
        let query = HKSampleQuery(
            sampleType: workoutType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
        ) { _, samples, error in
            if let error = error {
                continuation.resume(throwing: error)
                return
            }
            guard let workouts = samples as? [HKWorkout] else {
                continuation.resume(returning: [])
                return
            }
            let observations = workouts.map { workout -> Observation in
                let minutes = workout.duration / 60.0
                let distanceKm = workout.totalDistance?.doubleValue(for: .meterUnit(with: .kilo))
                let energyKcal = workout.totalEnergyBurned?.doubleValue(for: .kilocalorie())
                var valueText = String(format: "%.1f min", minutes)
                if let d = distanceKm { valueText += String(format: ", %.2f km", d) }
                if let e = energyKcal { valueText += String(format: ", %.0f kcal", e) }
                let activityName = workoutActivityName(workout.workoutActivityType)
                return Observation(
                    type: descriptor.observationType,
                    code: descriptor.code,
                    displayName: activityName,
                    valueReal: minutes,
                    valueText: valueText,
                    unit: descriptor.unit,
                    refLow: nil,
                    refHigh: nil,
                    effectiveDate: workout.startDate,
                    sourceMeta: sourceMeta(from: workout)
                )
            }
            continuation.resume(returning: observations)
        }
        store.execute(query)
    }
}

func queryElectrocardiograms(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    guard let ecgType = descriptor.objectType as? HKElectrocardiogramType else { return [] }
    guard let predicate = predicate(forDays: days) else { return [] }
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[Observation], Error>) in
        let query = HKSampleQuery(
            sampleType: ecgType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
        ) { _, samples, error in
            if let error = error {
                continuation.resume(throwing: error)
                return
            }
            guard let ecgSamples = samples as? [HKElectrocardiogram] else {
                continuation.resume(returning: [])
                return
            }
            let observations = ecgSamples.map { ecg -> Observation in
                let classification: String
                switch ecg.classification {
                case .sinusRhythm: classification = "Sinus Rhythm"
                case .atrialFibrillation: classification = "Atrial Fibrillation"
                case .inconclusiveHighHeartRate: classification = "High Heart Rate"
                case .inconclusiveLowHeartRate: classification = "Low Heart Rate"
                case .notSet: classification = "Not Set"
                case .inconclusivePoorReading: classification = "Poor Reading"
                case .inconclusiveOther: classification = "Inconclusive"
                case .unrecognized: classification = "Unrecognized"
                @unknown default: classification = "Inconclusive"
                }
                return Observation(
                    type: descriptor.observationType,
                    code: descriptor.code,
                    displayName: "ECG — \(classification)",
                    valueReal: nil,
                    valueText: classification,
                    unit: descriptor.unit,
                    refLow: nil,
                    refHigh: nil,
                    effectiveDate: ecg.startDate,
                    sourceMeta: sourceMeta(from: ecg)
                )
            }
            continuation.resume(returning: observations)
        }
        store.execute(query)
    }
}

func runDescriptor(_ store: HKHealthStore, descriptor: Descriptor, days: Int) async throws -> [Observation] {
    switch descriptor.kind {
    case .cumulative:
        return try await queryCumulative(store, descriptor: descriptor, days: days)
    case .discrete:
        return try await queryDiscrete(store, descriptor: descriptor, days: days)
    case .category:
        return try await queryCategory(store, descriptor: descriptor, days: days)
    case .workout:
        return try await queryWorkouts(store, descriptor: descriptor, days: days)
    case .electrocardiogram:
        return try await queryElectrocardiograms(store, descriptor: descriptor, days: days)
    }
}

func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    return encoder
}

func writeJSON<T: Encodable>(_ value: T) {
    let encoder = makeEncoder()
    if let data = try? encoder.encode(value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } else {
        let err = ErrorResponse(error: "Failed to encode output JSON")
        if let data = try? makeEncoder().encode(err) {
            FileHandle.standardOutput.write(data)
        }
    }
}

func main() async {
    guard let parsed = parseArgs(CommandLine.arguments) else { exit(2) }

    let descriptors: [Descriptor]
    do {
        descriptors = try makeDescriptors()
    } catch {
        writeJSON(ErrorResponse(error: "HealthKit not available"))
        exit(1)
    }

    let selected: [Descriptor]
    if parsed.type == "all" {
        selected = descriptors
    } else {
        guard let match = descriptors.first(where: { $0.arg == parsed.type }) else {
            writeJSON(ErrorResponse(error: "Unknown --type: \(parsed.type)"))
            exit(2)
        }
        selected = [match]
    }

    let store = HKHealthStore()
    do {
        try await authorize(store, descriptors: selected)
    } catch {
        writeJSON(ErrorResponse(error: "Authorization failed: \(error.localizedDescription)"))
        exit(3)
    }

    var allObservations: [Observation] = []
    var typesQueried: [String] = []
    for descriptor in selected {
        do {
            let observations = try await runDescriptor(store, descriptor: descriptor, days: parsed.days)
            allObservations.append(contentsOf: observations)
            typesQueried.append(descriptor.arg)
        } catch {
            FileHandle.standardError.write(Data("Query failed for \(descriptor.arg): \(error.localizedDescription)\n".utf8))
        }
    }

    if parsed.type == "all" {
        writeJSON(CombinedResult(observations: allObservations, queryDate: Date(), typesQueried: typesQueried))
    } else {
        writeJSON(allObservations)
    }
}

await main()
