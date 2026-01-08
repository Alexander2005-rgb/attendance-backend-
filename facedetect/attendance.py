import cv2
from deepface import DeepFace
import numpy as np
import os
import csv
from datetime import datetime
import logging
import requests
import time

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Configuration
DATASET_PATH = "backend/uploads"
MODEL_NAME = 'VGG-Face'
DETECTOR_BACKEND = 'retinaface'
DISTANCE_THRESHOLD = 0.4
FRAME_SCALE_FACTOR = 0.5
CAMERA_URL = 0  # Use 0 for webcam, or replace with your CCTV URL

def cosine_distance(a, b):
    """
    Calculate the cosine distance between two vectors.

    Args:
        a (np.array): First vector
        b (np.array): Second vector

    Returns:
        float: Cosine distance
    """
    return 1 - np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def load_known_faces(dataset_path):
    """
    Load known faces from the dataset directory.

    Args:
        dataset_path (str): Path to the directory containing student images

    Returns:
        tuple: (known_faces list, student_names list)
    """
    known_faces = []
    student_names = []

    if not os.path.exists(dataset_path):
        logging.error(f"Dataset path {dataset_path} does not exist")
        return known_faces, student_names

    for filename in os.listdir(dataset_path):
        if filename.endswith((".jpg", ".png", ".jpeg")):
            image_path = os.path.join(dataset_path, filename)
            try:
                result = DeepFace.represent(image_path, model_name=MODEL_NAME, detector_backend=DETECTOR_BACKEND, enforce_detection=False)
                if result:
                    known_faces.append(result[0]['embedding'])
                    student_names.append(os.path.splitext(filename)[0])
                    logging.info(f"Loaded face for {os.path.splitext(filename)[0]}")
                else:
                    logging.warning(f"No face detected in {filename}")
            except Exception as e:
                logging.error(f"Error processing {filename}: {str(e)}")

    logging.info(f"Loaded {len(student_names)} students from dataset")
    return known_faces, student_names

def initialize_attendance(date_today):
    """
    Initialize the attendance file for the current date.

    Args:
        date_today (str): Current date in YYYY-MM-DD format

    Returns:
        str: attendance_file path
    """
    attendance_file = f"attendance_{date_today}.csv"

    if not os.path.exists(attendance_file):
        with open(attendance_file, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["Name", "Date", "Time", "Status", "Class Period"])
        logging.info(f"Created new attendance file: {attendance_file}")

    return attendance_file

def process_frame(frame, known_faces, student_names, attendance_file, attendance_set, date_today, classPeriod=1):
    """
    Process a single frame for face detection and recognition.

    Args:
        frame (np.array): Video frame
        known_faces (list): List of known face embeddings
        student_names (list): List of student names
        attendance_file (str): Path to attendance file
        attendance_set (set): Set of already marked students
        date_today (str): Current date
        classPeriod (int): Class period number (default 1)

    Returns:
        np.array: Processed frame with bounding boxes
    """
    # Resize for faster processing
    small_frame = cv2.resize(frame, (0, 0), fx=FRAME_SCALE_FACTOR, fy=FRAME_SCALE_FACTOR)
    rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

    try:
        # Detect and represent faces
        results = DeepFace.represent(rgb_small_frame, model_name=MODEL_NAME, detector_backend=DETECTOR_BACKEND, enforce_detection=False)

        if not results:
            return frame

        # Process each detected face
        for result in results:
            face_encoding = result['embedding']
            facial_area = result['facial_area']

            # Compute distances to all known faces
            distances = [cosine_distance(face_encoding, known) for known in known_faces]
            min_distance = min(distances)
            best_match_index = distances.index(min_distance)

            if min_distance < DISTANCE_THRESHOLD:
                name = student_names[best_match_index]
            else:
                name = "Unknown"

            # Draw box around face
            x, y, w, h = facial_area['x'], facial_area['y'], facial_area['w'], facial_area['h']
            left, top, right, bottom = int(x / FRAME_SCALE_FACTOR), int(y / FRAME_SCALE_FACTOR), int((x + w) / FRAME_SCALE_FACTOR), int((y + h) / FRAME_SCALE_FACTOR)
            cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
            cv2.putText(frame, name, (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

            # Mark attendance if recognized
            if name != "Unknown":
                mark_attendance(name, date_today, attendance_file, attendance_set, classPeriod)

    except Exception as e:
        logging.error(f"Error processing frame: {str(e)}")

    return frame

def mark_attendance(rollNumber, date_today, attendance_file, attendance_set, classPeriod=1):
    """
    Mark attendance for a recognized student.

    Args:
        rollNumber (str): Roll number of the student
        date_today (str): Current date
        attendance_file (str): Path to attendance file
        attendance_set (set): Set of already marked students
        classPeriod (int): Class period number (default 1)
    """
    if rollNumber not in attendance_set:
        now = datetime.now()
        time_str = now.strftime("%H:%M:%S")
        # Save to CSV as backup
        with open(attendance_file, "a", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([rollNumber, date_today, time_str, "Present", f"Class {classPeriod}"])
        attendance_set.add(rollNumber)
        logging.info(f"Marked {rollNumber} as Present in Class {classPeriod} at {time_str}")

        # Send to backend API
        try:
            response = requests.post('http://localhost:5000/api/attendance/mark', json={
                'rollNumber': rollNumber,
                'date': date_today,
                'time': time_str,
                'status': 'present',
                'classPeriod': classPeriod
            })
            if response.status_code == 200:
                logging.info(f"Sent attendance for {rollNumber} (Class {classPeriod}) to backend")
            else:
                logging.warning(f"Failed to send attendance for {rollNumber} (Class {classPeriod}): {response.text}")
        except Exception as e:
            logging.error(f"Error sending attendance to backend: {str(e)}")

def main():
    """
    Main function to run the face attendance system with automatic restart and class period alternation.
    """
    # Load known faces
    known_faces, student_names = load_known_faces(DATASET_PATH)

    if not known_faces:
        logging.error("No known faces loaded. Exiting.")
        return

    # Initialize attendance file (only once per day)
    date_today = datetime.now().strftime("%Y-%m-%d")
    attendance_file = initialize_attendance(date_today)

    # Class period alternation (1 to 6)
    class_period = 1
    cycle_count = 0

    logging.info("Starting continuous face attendance system with automatic restart.")
    logging.info("System will cycle through Class Periods 1 to 6.")
    logging.info("Each cycle: 1 minute active, 1 minute sleep, then automatic restart.")
    logging.info("System will automatically close after completing all 6 class periods.")
    logging.info("Press 'q' to quit.")

    try:
        while class_period <= 6:
            cycle_count += 1
            logging.info(f"Starting cycle {cycle_count} - Class Period {class_period}")

            # Initialize fresh attendance_set for each class period
            attendance_set = set()

            # Open camera
            cap = cv2.VideoCapture(CAMERA_URL)

            if not cap.isOpened():
                logging.error("Unable to access camera feed")
                time.sleep(60)  # Wait before retrying
                continue

            start_time = time.time()
            logging.info("Running attendance for 1 minute.")

            try:
                while True:
                    ret, frame = cap.read()
                    if not ret:
                        logging.error("Unable to read frame from camera")
                        break

                    # Process frame for multiple faces
                    processed_frame = process_frame(frame, known_faces, student_names, attendance_file, attendance_set, date_today, class_period)

                    cv2.imshow("CCTV Face Attendance", processed_frame)

                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        return

                    if time.time() - start_time > 60:  # Run for 1 minute
                        break
            except KeyboardInterrupt:
                logging.info("Interrupted by user")
                return
            finally:
                cap.release()
                cv2.destroyAllWindows()

            # Attendance automatically sent during processing
            logging.info(f"Completed Class Period {class_period} attendance cycle {cycle_count}")
            logging.info("Attendance data has been automatically saved and sent to backend.")

            # Sleep for 1 minute
            logging.info("System stopped for 1 minute break...")
            time.sleep(10)

            # Move to next class period
            class_period += 1

            if class_period <= 6:
                logging.info(f"Restarting with Class Period {class_period}")
            else:
                logging.info("Completed all 6 class periods. System will now close.")

    except Exception as e:
        logging.error(f"Error in main loop: {str(e)}")
    finally:
        logging.info("Face attendance system stopped.")
        logging.info("All class periods (1-6) have been completed.")

if __name__ == "__main__":
    main()
