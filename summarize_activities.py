import json

target_exercises = [
    "Barbell Back Squat", "Barbell Bench Press", "Barbell Deadlift",
    "Overhead Barbell Press", "Barbell Shoulder Press", "Barbell Hang Power Clean",
    "Chest Supported Dumbbell Row", "Back Foot Elevated Dumbbell Split Squat",
    "Single Leg Romanian Deadlift With Dumbbell"
]

row_alternatives = [
    "Alternating Dumbbell Row", "Single Arm Neutral Grip Dumbbell Row",
    "Dumbbell Row", "One Arm Bent Over Row", "One-legged Dumbbell Row"
]

def format_val(val, val_list):
    return val_list if val_list else val

with open('data/activities-50.tmp.json', 'r') as f:
    data = json.load(f)

latest_exercises = {}
row_matches = []
running_sessions = []

for activity in data.get('activities', []):
    activity_name = activity.get('activityName', 'Unknown')
    start_time = activity.get('startTime', '')
    activity_type = activity.get('activityType', '')
    
    if activity_type == 'strength_training':
        for exercise in activity.get('exerciseSets', []):
            name = exercise.get('exerciseName', '')
            if name in target_exercises:
                if name not in latest_exercises or start_time > latest_exercises[name]['date']:
                    latest_exercises[name] = {
                        'date': start_time,
                        'workout': activity_name,
                        'sets': exercise.get('sets'),
                        'reps': format_val(exercise.get('reps'), exercise.get('repsList')),
                        'weight': format_val(exercise.get('weight'), exercise.get('weightList'))
                    }
            if name in row_alternatives:
                row_matches.append({
                    'name': name, 'date': start_time,
                    'reps': format_val(exercise.get('reps'), exercise.get('repsList')),
                    'weight': format_val(exercise.get('weight'), exercise.get('weightList'))
                })
    
    if activity_type == 'running':
        distance_km = activity.get('distance', 0) / 1000.0
        if 3.0 <= distance_km <= 5.0:
             running_sessions.append(activity)

print("### LATEST TARGET EXERCISES ###")
for ex in target_exercises:
    if ex in latest_exercises:
        d = latest_exercises[ex]
        print(f"{ex}: {d['date']} | {d['workout']} | Sets: {d['sets']} | Reps: {d['reps']} | Weight: {d['weight']}")

print("\n### ROW ALTERNATIVES ###")
# Filter to only the most recent couple of matches for brevity but mention them
row_matches.sort(key=lambda x: x['date'], reverse=True)
for m in row_matches[:5]:
    print(f"{m['name']}: {m['date']} | Reps: {m['reps']} | Weight: {m['weight']}")

print("\n### RECENT HIGH-INTENSITY RUNNING (APPROX 4KM) ###")
running_sessions.sort(key=lambda x: x.get('startTime', ''), reverse=True)
# Filter for "High Intensity" - assuming non-base labels or high HR
for run in running_sessions:
    label = run.get('trainingEffectLabel', '')
    if label in ['VO2_MAX', 'THRESHOLD', 'ANAEROBIC_CAPACITY', 'AEROBIC_BASE']: # Include Base if it's the only ones found
        dist_km = run.get('distance', 0) / 1000.0
        print(f"Date: {run.get('startTime')} | Name: {run.get('activityName')} | Dist: {dist_km:.2f}km | HR: {run.get('avgHR')}/{run.get('maxHR')} | Label: {label}")
